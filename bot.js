import 'dotenv/config';
import { Bot } from '@maxhub/max-bot-api';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

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

bot.on('message_created', async (ctx) => {
  const msg = ctx.message;
  const senderId = msg.sender.user_id;
  const text = msg.body.text;

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

    // ИСПРАВЛЕНО: msg.link вместо msg.body.link
    if (msg.link && msg.link.type === 'reply') {
      // ИСПРАВЛЕНО: путь к mid через msg.link.message.mid
      const repliedMsgMid = msg.link.message.mid; 
      
      console.log(`[REPLY] Ответ на сообщение: ${repliedMsgMid}`);
      
      const target = await db.get('SELECT client_user_id FROM reply_map WHERE owner_msg_mid = ?', repliedMsgMid);

      if (target) {
        try {
          await bot.api.sendMessageToUser(target.client_user_id, text);
          return ctx.reply(`✅ Ответ отправлен пользователю ID: ${target.client_user_id}`);
        } catch (e) {
          console.error(e);
          return ctx.reply('❌ Ошибка отправки.');
        }
      } else {
        return ctx.reply('⚠️ Пользователь не найден в базе (возможно, старое сообщение).');
      }
    }

    // Fallback
    if (global.lastClient && global.lastClient !== ownerId) {
      try {
        await bot.api.sendMessageToUser(global.lastClient, text);
        return ctx.reply(`✅ Отправлено последнему активному (${global.lastClient}).\n\nℹ️ Используйте Reply для точного ответа.`);
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

    const forwardText = `📩 **Сообщение от ${msg.sender.first_name}** (ID: ${senderId}):\n\n${text}`;
    
    const sentMsg = await bot.api.sendMessageToUser(ownerId, forwardText, { format: 'markdown' });

    if (sentMsg && sentMsg.body && sentMsg.body.mid) {
        console.log(`[SAVE] MsgID: ${sentMsg.body.mid} -> UserID: ${senderId}`);
        await db.run('INSERT OR REPLACE INTO reply_map (owner_msg_mid, client_user_id) VALUES (?, ?)', 
          [sentMsg.body.mid, senderId]);
    }
  } catch (e) {
    console.error('Ошибка при пересылке:', e);
  }
});

bot.start();
console.log('Бот запущен...');