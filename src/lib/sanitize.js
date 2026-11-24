// Rich-text sanitizer for everything an admin types into a WYSIWYG editor.
import sanitizeHtml from 'sanitize-html';

const OPTIONS = {
  allowedTags: [
    'p', 'br', 'hr', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote',
    'ul', 'ol', 'li', 'a', 'img', 'figure', 'figcaption', 'code', 'pre', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    span: ['class'],
    p: ['class'],
    li: ['class', 'data-list'],
    ol: ['class'],
    ul: ['class'],
  },
  // Quill alignment / indent classes only.
  allowedClasses: {
    '*': ['ql-align-center', 'ql-align-right', 'ql-align-justify', 'ql-indent-1', 'ql-indent-2', 'ql-size-small', 'ql-size-large'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => {
      const out = { ...attribs };
      if (/^https?:/i.test(out.href || '')) {
        out.target = '_blank';
        out.rel = 'noopener noreferrer';
      } else {
        delete out.target;
      }
      return { tagName, attribs: out };
    },
    h1: 'h2',
  },
};

/** Sanitize admin-authored rich text before storing it. Output is safe for <%- %>. */
export function sanitizeRichText(html) {
  return sanitizeHtml(String(html ?? ''), OPTIONS).trim();
}

/** Remove every tag (plain text fields). */
export function sanitizePlain(text) {
  return sanitizeHtml(String(text ?? ''), { allowedTags: [], allowedAttributes: {} }).trim();
}
