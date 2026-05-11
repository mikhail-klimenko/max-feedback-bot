import 'dotenv/config';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import {
  Bot,
  ImageAttachment,
  VideoAttachment,
  AudioAttachment,
  FileAttachment
} from '@maxhub/max-bot-api';

const token = process.env.BOT_TOKEN;
const ownerId = Number(process.env.OWNER_ID);
if (!token || !ownerId) throw new Error('Token or OWNER_ID not provided');

const bot = new Bot(token);

// --- База Данных ---
let db;
(async () => {
  db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      first_name TEXT,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS reply_map (
      owner_msg_mid TEXT PRIMARY KEY,
      client_user_id INTEGER
    )
  `);
  
  console.log('База данных готова');
})();

// Преобразует входящие вложения в формат для отправки
function prepareAttachments(attachments) {
  if (!attachments || attachments.length === 0) return [];

  return attachments.map(att => {
    // Токен может быть в payload.token или просто в token
    const fileToken = att.payload?.token || att.token;
    if (!fileToken) return null;

    switch (att.type) {
      case 'image':
        return new ImageAttachment({ token: fileToken }).toJson();
      case 'video':
        return new VideoAttachment({ token: fileToken }).toJson();
      case 'audio':
        return new AudioAttachment({ token: fileToken }).toJson();
      case 'file':
        return new FileAttachment({ token: fileToken }).toJson();
      default:
        return null;
    }
  }).filter(Boolean); 
}

bot.on('message_created', async (ctx) => {
  const msg = ctx.message;
  const senderId = msg.sender.user_id;
  const text = msg.body.text || '';
  const attachments = msg.body.attachments;

  // 1. Если пишет ВЛАДЕЛЕЦ
  if (senderId === ownerId) {
    
    if (text === '/stats') {
      try {
        const count = await db.get('SELECT COUNT(*) as count FROM users');
        const lastUsers = await db.all('SELECT * FROM users ORDER BY last_activity DESC LIMIT 5');
        let response = `📊 **Статистика**\n\nВсего пользователей: ${count.count}\n\nПоследние активности:\n`;
        lastUsers.forEach(u => { response += `- ${u.first_name} (ID: ${u.user_id})\n`; });
        return ctx.reply(response, { format: 'markdown' });
      } catch (e) { return ctx.reply('Ошибка чтения БД'); }
    }

    // Обработка Reply
    if (msg.link && msg.link.type === 'reply') {
      const repliedMsgMid = msg.link.message.mid; 
      const target = await db.get('SELECT client_user_id FROM reply_map WHERE owner_msg_mid = ?', repliedMsgMid);

      if (target) {
        try {
          const attachmentsToSend = prepareAttachments(attachments);
          await bot.api.sendMessageToUser(target.client_user_id, text, { attachments: attachmentsToSend });
          
          let confirmation = `✅ Ответ отправлен ID: ${target.client_user_id}`;
          if (attachmentsToSend.length > 0) confirmation += ` (с ${attachmentsToSend.length} влож.)`;
          return ctx.reply(confirmation);
        } catch (e) {
          console.error('Ошибка отправки:', e);
          return ctx.reply('❌ Ошибка отправки.');
        }
      } else {
        return ctx.reply('⚠️ Пользователь не найден в базе.');
      }
    }

    // Fallback
    if (global.lastClient && global.lastClient !== ownerId) {
      try {
        const attachmentsToSend = prepareAttachments(attachments);
        await bot.api.sendMessageToUser(global.lastClient, text, { attachments: attachmentsToSend });
        return ctx.reply(`✅ Отправлено последнему активному.`);
      } catch (e) {
        return ctx.reply('❌ Ошибка отправки.');
      }
    } else {
      return ctx.reply('ℹ️ Нет активных диалогов.');
    }
  }

  // 2. Если пишет КЛИЕНТ
  try {
    await db.run(`INSERT INTO users (user_id, first_name, last_activity) VALUES (?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(user_id) DO UPDATE SET last_activity = CURRENT_TIMESTAMP, first_name=excluded.first_name`,
      [senderId, msg.sender.first_name]);

    global.lastClient = senderId;

    let forwardText = `📩 **Сообщение от ${msg.sender.first_name}** (ID: ${senderId}):`;
    if (text) forwardText += `\n\n${text}`;
    if (attachments && attachments.length > 0) {  
        forwardText += `\n\n_(присоединено файлов: ${attachments.length})_`;
    }

    const attachmentsToForward = prepareAttachments(attachments);

    const sentMsg = await bot.api.sendMessageToUser(ownerId, forwardText, { 
      format: 'markdown',
      attachments: attachmentsToForward 
    });

    if (sentMsg && sentMsg.body && sentMsg.body.mid) {
        await db.run('INSERT OR REPLACE INTO reply_map (owner_msg_mid, client_user_id) VALUES (?, ?)', 
          [sentMsg.body.mid, senderId]);
    }
  } catch (e) {
    console.error('Ошибка при пересылке:', e);
  }
});

bot.start();
console.log('Бот запущен...');