/**
 * Instagram's caption limits (Graph API content publishing): 2,200
 * characters, at most 30 hashtags and 20 @mentions. Over any of them the
 * container call fails, so they are checked before a post is accepted.
 */
export const CAPTION_MAX = 2200;
export const HASHTAG_MAX = 30;
export const MENTION_MAX = 20;

const HASHTAG_RE = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu;
const MENTION_RE = /(^|[^\p{L}\p{N}_.])@([A-Za-z0-9_.]{1,30})/gu;

export function hashtagsIn(text: string): string[] {
  return [...text.matchAll(HASHTAG_RE)].map((m) => `#${m[2]}`);
}

export function mentionsIn(text: string): string[] {
  return [...text.matchAll(MENTION_RE)].map((m) => `@${m[2]}`);
}

/** Characters as Instagram counts them (code points, not UTF-16 units). */
export function captionLength(text: string): number {
  return [...text].length;
}

export type CaptionCheck = { ok: boolean; length: number; hashtags: number; mentions: number; errors: string[] };

export function checkCaption(text: string): CaptionCheck {
  const length = captionLength(text);
  const hashtags = new Set(hashtagsIn(text).map((t) => t.toLowerCase())).size;
  const mentions = new Set(mentionsIn(text).map((t) => t.toLowerCase())).size;
  const errors: string[] = [];
  if (length > CAPTION_MAX) errors.push(`Caption is ${length} characters; Instagram allows ${CAPTION_MAX}.`);
  if (hashtags > HASHTAG_MAX) errors.push(`Caption has ${hashtags} hashtags; Instagram allows ${HASHTAG_MAX}.`);
  if (mentions > MENTION_MAX) errors.push(`Caption has ${mentions} mentions; Instagram allows ${MENTION_MAX}.`);
  return { ok: errors.length === 0, length, hashtags, mentions, errors };
}

/** Normalises a hashtag set ("gym, #whey  protein") to "#gym #whey #protein". */
export function normaliseTags(raw: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const word = part.replace(/^#+/, "").trim();
    if (!word || !/^[\p{L}\p{N}_]+$/u.test(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${word}`);
  }
  return out.join(" ");
}

/**
 * Appends a hashtag set to a caption, skipping tags the caption already has,
 * separated by a blank line the way the brands post them.
 */
export function appendHashtags(caption: string, tags: string): string {
  const have = new Set(hashtagsIn(caption).map((t) => t.toLowerCase()));
  const extra = normaliseTags(tags)
    .split(" ")
    .filter((t) => t && !have.has(t.toLowerCase()));
  if (!extra.length) return caption;
  const base = caption.replace(/\s+$/, "");
  return base ? `${base}\n\n${extra.join(" ")}` : extra.join(" ");
}
