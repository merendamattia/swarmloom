const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const timingStepSeconds = 0.001;

export function parseRepositoryList(value: string) {
  return [...new Set(value.split(/[\s,]+/).map((repository) => repository.trim()).filter(Boolean))];
}

export function removeRepository(repositories: string[], repository: string) {
  return repositories.length <= 1 ? repositories : repositories.filter((value) => value !== repository);
}

export function secondsToMilliseconds(seconds: number) {
  return Math.round(seconds * 1_000);
}

export function millisecondsToSeconds(milliseconds: number) {
  return milliseconds / 1_000;
}

export function describeCron(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return "Enter a five-part cron expression.";
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Every minute";
  }

  const minuteInterval = /^\*\/(\d+)$/.exec(minute)?.[1];
  if (minuteInterval && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${unit(Number(minuteInterval), "minute")}`;
  }

  const hourInterval = /^\*\/(\d+)$/.exec(hour)?.[1];
  if (minute === "0" && hourInterval && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${unit(Number(hourInterval), "hour")}`;
  }

  if (minute === "0" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Every hour";
  }

  const time = simpleTime(hour, minute);
  if (time) {
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every day at ${time}`;
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") return `At ${time} on weekdays`;
    if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*") return `At ${time} on ${weekday(dayOfWeek)}`;
    if (dayOfMonth !== "*" && month === "*" && dayOfWeek === "*") return `At ${time} on day ${dayOfMonth} of every month`;
  }

  return `Scheduled by cron: ${expression}`;
}

function unit(value: number, singular: string) {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function simpleTime(hour: string, minute: string) {
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) return null;
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function weekday(value: string) {
  const normalized = value.toUpperCase();
  const namedIndex = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].indexOf(normalized);
  if (namedIndex >= 0) return weekdays[namedIndex];
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 7
    ? weekdays[numeric === 7 ? 0 : numeric]
    : value;
}
