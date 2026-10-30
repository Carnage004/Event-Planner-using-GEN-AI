import { createHash } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { onSchedule } from 'firebase-functions/v2/scheduler';

const app = getApps()[0] || initializeApp();
const db = getFirestore(app);
const messaging = getMessaging(app);
const WINDOW_MS = 3 * 60 * 1000;

function localDateTimeToUtc(date, time, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}$/.test(String(time))) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59) return null;
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const difference = target - represented;
    if (!difference) break;
    guess += difference;
  }
  return new Date(guess);
}

export const sendTimelineReminders = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'UTC',
  region: 'asia-south1',
  maxInstances: 1,
}, async () => {
  const now = new Date();
  const users = await db.collection('users').get();
  for (const userDoc of users.docs) {
    const userRef = userDoc.ref;
    const [plans, devices] = await Promise.all([
      userRef.collection('plans').get(),
      userRef.collection('devices').get(),
    ]);
    if (devices.empty) continue;
    const activeDevices = devices.docs.filter(doc => doc.data().token);
    if (!activeDevices.length) continue;

    for (const planDoc of plans.docs) {
      const plan = planDoc.data();
      const event = plan.eventData || {};
      const date = plan.date || event.date;
      const timeline = Array.isArray(event.timeline) ? event.timeline : [];
      for (const [index, item] of timeline.entries()) {
        if (!item || item.done || !item.time) continue;
        const due = localDateTimeToUtc(date, item.time, event.timeZone || 'Asia/Kolkata');
        if (!due || due > now || due < new Date(now.getTime() - WINDOW_MS)) continue;

        const receiptId = createHash('sha256').update(`${planDoc.id}|${date}|${index}|${item.time}|${item.title || ''}`).digest('hex');
        const receiptRef = userRef.collection('notificationReceipts').doc(receiptId);
        const claimed = await db.runTransaction(async transaction => {
          const receipt = await transaction.get(receiptRef);
          if (receipt.exists) return false;
          transaction.create(receiptRef, { status: 'sending', createdAt: FieldValue.serverTimestamp(), planId: planDoc.id });
          return true;
        });
        if (!claimed) continue;

        const title = String(item.title || 'Timeline moment').slice(0, 100);
        const body = `${String(plan.name || 'Your celebration').slice(0, 80)} · ${String(item.time).slice(0, 5)}${item.note ? ` — ${String(item.note).slice(0, 120)}` : ''}`;
        let sent = 0;
        for (const deviceDoc of activeDevices) {
          const device = deviceDoc.data();
          try {
            await messaging.send({
              token: device.token,
              data: { title: `Jashn · ${title}`, body, url: device.origin ? `${device.origin}/` : '/' },
              webpush: { headers: { Urgency: 'high' }, fcmOptions: device.origin?.startsWith('https://') ? { link: `${device.origin}/` } : undefined },
            });
            sent += 1;
          } catch (error) {
            if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) await deviceDoc.ref.delete();
            else console.error('Timeline push delivery failed:', error.code || error.message);
          }
        }
        if (sent) await receiptRef.update({ status: 'sent', sentAt: FieldValue.serverTimestamp(), deviceCount: sent });
        else await receiptRef.delete();
      }
    }
  }
});