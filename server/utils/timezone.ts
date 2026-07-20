import { z } from 'zod';

// Common IANA timezone validation
const timezoneSchema = z.string().refine((tz) => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Invalid timezone");

export function validateTimezone(timezone: string): boolean {
  return timezoneSchema.safeParse(timezone).success;
}

export function convertToUTC(localTime: string, timezone: string, date?: Date): Date {
  const baseDate = date || new Date();
  const [hours, minutes] = localTime.split(':').map(Number);
  
  // Create date in the specified timezone
  const localDate = new Date(baseDate);
  localDate.setHours(hours, minutes, 0, 0);
  
  // Convert to UTC
  const tempDate = new Date(localDate.toLocaleString("en-US", { timeZone: timezone }));
  const diff = localDate.getTime() - tempDate.getTime();
  return new Date(localDate.getTime() + diff);
}

export function getNextScheduledTime(
  localTime: string, 
  timezone: string, 
  frequency: 'daily' | 'weekly',
  weekday?: number
): Date {
  const now = new Date();
  let nextRun = convertToUTC(localTime, timezone, now);
  
  if (frequency === 'daily') {
    // If time has passed today, schedule for tomorrow
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }
  } else if (frequency === 'weekly' && typeof weekday === 'number') {
    // Find next occurrence of the specified weekday
    const currentDay = now.getDay();
    const daysUntilTarget = (weekday - currentDay + 7) % 7;
    
    if (daysUntilTarget === 0 && nextRun <= now) {
      // If it's today but time has passed, schedule for next week
      nextRun.setDate(nextRun.getDate() + 7);
    } else {
      nextRun.setDate(nextRun.getDate() + daysUntilTarget);
    }
  }
  
  return nextRun;
}

export function formatTimeInTimezone(date: Date, timezone: string): string {
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}
