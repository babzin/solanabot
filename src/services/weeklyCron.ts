import { env } from '../config/env.js';
import { calculateWeeklyStats, renderWeeklyReportText } from './weeklyReport.js';
import { bot } from './telegram.js';

let lastSentWeekLabel = '';

/**
 * Initializes the automated End-of-Week Cumulative Report Scheduler.
 * Automatically checks and sends the weekly performance recap every Sunday at 23:55 UTC.
 */
export function initWeeklyReportCron(): void {
  console.log('🗓️ Weekly Performance Report Cron: Online (Automated Sunday 23:55 UTC Dispatcher)');

  // Check every 5 minutes
  setInterval(async () => {
    try {
      const now = new Date();
      const utcDay = now.getUTCDay(); // 0 is Sunday
      const utcHour = now.getUTCHours();
      const utcMinute = now.getUTCMinutes();

      // Trigger condition: Sunday between 23:50 and 23:59 UTC
      if (utcDay === 0 && utcHour === 23 && utcMinute >= 50) {
        const stats = await calculateWeeklyStats(0);
        if (lastSentWeekLabel !== stats.weekLabel) {
          lastSentWeekLabel = stats.weekLabel;
          console.log(`📢 [Weekly Report] Dispatching automated End-of-Week Performance Recap for ${stats.weekLabel}...`);

          const report = renderWeeklyReportText(stats);
          const chatId = env.TELEGRAM_CHAT_ID;

          if (chatId && chatId !== '0') {
            await bot.sendMessage(chatId, report, {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
                    { text: '💎 Daily Coins', callback_data: 'cmd_early' },
                  ],
                  [
                    { text: '📉 Daily Flops', callback_data: 'cmd_flops' },
                    { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
                  ],
                ],
              },
            });
            console.log(`✅ [Weekly Report] Successfully dispatched weekly report for ${stats.weekLabel}`);
          }
        }
      }
    } catch (err: any) {
      console.warn('⚠️ [Weekly Report Cron] Error during scheduled check:', err.message);
    }
  }, 5 * 60 * 1000);
}
