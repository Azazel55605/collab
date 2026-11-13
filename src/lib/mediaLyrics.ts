interface LyricLine {
  time: number;
  text: string;
}

const MAX_LINES = 4000;
const TIMESTAMP = /^\[(\d{1,5}):([0-5]\d)(?:[.:](\d{1,3}))?\]/;
const METADATA = /^\[[a-z][\w-]*:.*\]$/i;

export function parseLyrics(input: string) {
  const rows = input.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  const offsetTag = input.match(/^\s*\[offset:\s*([+-]?\d{1,9})\s*\]\s*$/im);
  const offset = Number(offsetTag?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];
  const plain: string[] = [];

  for (const row of rows) {
    let text = row.trim();
    const timestamps: number[] = [];
    let match = TIMESTAMP.exec(text);
    while (match && timestamps.length + lines.length < MAX_LINES) {
      const fraction = Number(match[3]?.padEnd(3, '0') ?? 0) / 1000;
      timestamps.push(Math.max(0, Number(match[1]) * 60 + Number(match[2]) + fraction + offset));
      text = text.slice(match[0].length);
      match = TIMESTAMP.exec(text);
    }
    if (timestamps.length) {
      // A timestamp with no text clears the highlight during an instrumental.
      text = text.replace(/<\d{1,5}:[0-5]\d(?:[.:]\d{1,3})?>/g, '').trim();
      for (const time of timestamps) lines.push({ time, text });
    } else if (!METADATA.test(text)) {
      plain.push(row);
    }
  }

  if (!lines.some((line) => line.text)) return { lines: [], text: plain.join('\n').trim() };

  lines.sort((a, b) => a.time - b.time);
  const grouped: LyricLine[] = [];
  for (const line of lines) {
    const previous = grouped[grouped.length - 1];
    if (previous?.time !== line.time) grouped.push(line);
    else if (line.text && line.text !== previous.text) {
      previous.text = [previous.text, line.text].filter(Boolean).join('\n');
    }
  }
  return { lines: grouped, text: '' };
}

export function lyricIndexAt(lines: LyricLine[], position: number) {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].time <= position) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
