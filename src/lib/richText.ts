import sanitizeHtml from "sanitize-html";

/*
 * Descriptions are rich text now, which means they are HTML, which means they
 * are the one field in this API whose contents get interpreted by a browser
 * rather than displayed as characters.
 *
 * The frontend renders these with `dangerouslySetInnerHTML` — there is no way
 * to show formatting without doing so — and that makes THIS FILE the boundary.
 * A description written by one employee is rendered in every colleague's
 * browser, on the app's own origin, alongside their session. Stored XSS here is
 * not a defacement, it is an account takeover with a plausible delivery route:
 * type it into a task, wait for a manager to open the task.
 *
 * So the rule is: nothing is stored that a browser could be asked to execute.
 * Sanitising on the way IN rather than on the way out means the database can
 * never hold a payload, so a future read path that forgets to sanitise cannot
 * resurrect one, and existing rows do not have to be trusted.
 */

/**
 * What the editor can produce, and nothing else.
 *
 * An allowlist, matched to the toolbar the frontend actually offers. No
 * `<script>` and no `<style>` (both execute); no `<iframe>`, `<object>` or
 * `<embed>` (all load a document); no `<img>` (its `onerror` is the classic
 * payload and the editor cannot insert one anyway); no `<form>` or `<input>`
 * (a login box drawn inside a task description is a credible phish).
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "blockquote",
  "code",
  "pre",
  "a",
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  // Only links carry attributes. Notably absent: `style`, which can position an
  // element over the page and turn a description into an invisible overlay, and
  // every `on*` handler, which sanitize-html drops by virtue of not being here.
  //
  // `rel` and `target` are listed because the allowlist is applied AFTER
  // `transformTags` below — leaving them out silently stripped the very
  // attributes that transform exists to add.
  allowedAttributes: { a: ["href", "title", "rel", "target"] },
  // `javascript:` and `data:` are the two that execute. An anchor is worth
  // having; an anchor that can run code is not.
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  // A link that leaves the app opens in a new tab and cannot reach back through
  // `window.opener` to redirect the page it came from.
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
  },
  // Text inside a disallowed tag is kept; the tag itself goes. Dropping the text
  // as well would silently eat a paragraph someone wrote because of one stray
  // element pasted from Word.
  nonTextTags: ["script", "style", "textarea", "noscript"],
};

/**
 * Clean one rich-text field.
 *
 * Returns the sanitised HTML, or an empty string for anything that carries no
 * text at all — the editor emits `<p></p>` for an empty document, which is not
 * nothing to a length check but is nothing to a reader, and storing it would
 * make "has a description" true for every record ever opened.
 */
export function sanitizeRichText(html: string): string {
  const clean = sanitizeHtml(html, OPTIONS).trim();
  return hasVisibleText(clean) ? clean : "";
}

/** Whether anything survives once the markup is taken away. */
function hasVisibleText(html: string): boolean {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, " ")
    .trim().length > 0;
}
