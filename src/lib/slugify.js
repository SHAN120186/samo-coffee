// Cyrillic-aware slugify: "Эфиопия Иргачефф 250 г" -> "efiopiya-irgacheff-250-g"

const MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Uzbek Cyrillic extras
  ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

export function slugify(input, { maxLength = 80, fallback = 'item' } = {}) {
  const lower = String(input ?? '').toLowerCase().normalize('NFC');
  let out = '';
  for (const ch of lower) {
    if (MAP[ch] !== undefined) out += MAP[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, maxLength).replace(/-$/, '');
  return out || fallback;
}

/**
 * Make a slug unique. `exists(slug)` must return true when the slug is taken.
 * uniqueSlug('kofe', s => taken.has(s)) -> "kofe" | "kofe-2" | "kofe-3" ...
 */
export function uniqueSlug(base, exists) {
  const root = slugify(base);
  if (!exists(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}
