'use strict';
// What a reader sees in post content: its text and media, and the paragraphs a change adds or removes.
// Used by preview_edit and stage_edit to describe a proposed change before anything is written.

const MEDIA = /<(?:img|video|audio|iframe|embed|object)\b[^>]*>/gi;
// Closing tags of elements that end a paragraph of text.
const BREAKS = /<\/(?:p|h[1-6]|li|blockquote|figcaption|td|th|dt|dd|pre|div|section)>|<br\s*\/?>/gi;

const decodeEntities = text => text
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) < 0x110000 ? Number(n) : 32))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) < 0x110000 ? parseInt(n, 16) : 32))
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, '\'')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/** Paragraphs of visible text: block comments, scripts, styles and tags removed, entities decoded. */
function paragraphs(content) {
  return decodeEntities(String(content ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(BREAKS, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const clip = (text, max = 200) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** Text and media counts before and after, plus the paragraphs that were removed or added (at most 20 of each). */
function contentChange(before, after) {
  const was = paragraphs(before);
  const now = paragraphs(after);
  const count = list => list.reduce((map, line) => map.set(line, (map.get(line) || 0) + 1), new Map());
  const left = count(now);
  const removed = [];
  for (const line of was) {
    if (left.get(line)) left.set(line, left.get(line) - 1);
    else removed.push(line);
  }
  const kept = count(was);
  const added = [];
  for (const line of now) {
    if (kept.get(line)) kept.set(line, kept.get(line) - 1);
    else added.push(line);
  }
  const chars = list => list.join(' ').length;
  return {
    text_chars_before: chars(was),
    text_chars_after: chars(now),
    media_before: (String(before ?? '').match(MEDIA) || []).length,
    media_after: (String(after ?? '').match(MEDIA) || []).length,
    paragraphs_removed: removed.length,
    paragraphs_added: added.length,
    removed: removed.slice(0, 20).map(line => clip(line)),
    added: added.slice(0, 20).map(line => clip(line)),
  };
}

// Content-loss guard. Below this many visible characters a ratio means little, so short posts are not checked.
const LOSS_MIN_TEXT = 200;
// Fewer media items than this can be removed in an ordinary edit.
const LOSS_MIN_MEDIA = 3;
// Keeping less than this share of the text or media counts as a loss.
const LOSS_MIN_RATIO = 0.5;
// Elements that show nothing without a source.
const SOURCED = /<(?:img|iframe|embed|source)\b[^>]*>/gi;
const HAS_SOURCE = /\s(?:src|srcset)\s*=\s*(?:"[^"\s]|'[^'\s]|[^"'\s>])/i;

const sourceless = content => (String(content ?? '').match(SOURCED) || []).filter(tag => !HAS_SOURCE.test(tag)).length;

/**
 * Whether replacing before with after loses most of the post: less than half its text (posts of 200+ characters),
 * less than half its media (posts with 3+ items), or images and embeds left without a source.
 * Returns {text_chars_before, text_chars_after, media_before, media_after, reasons} or null.
 */
function contentLoss(before, after) {
  const textBefore = paragraphs(before).join(' ').length;
  const textAfter = paragraphs(after).join(' ').length;
  const mediaBefore = (String(before ?? '').match(MEDIA) || []).length;
  const mediaAfter = (String(after ?? '').match(MEDIA) || []).length;
  const reasons = [];
  if (textBefore >= LOSS_MIN_TEXT && textAfter < textBefore * LOSS_MIN_RATIO) reasons.push('text');
  if (mediaBefore >= LOSS_MIN_MEDIA && mediaAfter < mediaBefore * LOSS_MIN_RATIO) reasons.push('media');
  if (sourceless(after) > sourceless(before)) reasons.push('empty_media');
  return reasons.length ? {text_chars_before: textBefore, text_chars_after: textAfter, media_before: mediaBefore, media_after: mediaAfter, reasons} : null;
}

/** Refuse a content write that would lose most of the post, unless the user explicitly wants it (allow). */
function requireNoContentLoss(ctx, kind, postId, before, after, allow) {
  if (allow || typeof before !== 'string') return;
  const loss = contentLoss(before, after);
  if (!loss) return;
  const what = [];
  if (loss.reasons.includes('text')) what.push('keeps ' + loss.text_chars_after + ' of ' + loss.text_chars_before + ' characters of text');
  if (loss.reasons.includes('media')) what.push('keeps ' + loss.media_after + ' of ' + loss.media_before + ' images, videos and embeds');
  if (loss.reasons.includes('empty_media')) what.push('adds images or embeds with no source');
  throw Object.assign(new Error('This change ' + what.join(' and ') + ' of ' + kind + ' ' + postId + ' on site ' + ctx.site.site_id + ', so it looks like content was lost (for example a shortened copy sent instead of the full content). Nothing was saved. Read the ' + kind + ' again with get_post and send the complete content, or use edit_blocks to change only the parts that should change. If the user explicitly wants to remove that much, show them preview_edit and pass allow_content_loss: true.'), {contentLoss: loss});
}

module.exports = {paragraphs, contentChange, contentLoss, requireNoContentLoss};
