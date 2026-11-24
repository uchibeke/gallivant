import { createRequire } from "node:module";
import { externalLinkAttributes } from "./links.mjs";

const require = createRequire(import.meta.url);
const headingSlug = text => text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
let renderer;

function markdownRenderer() {
  if (renderer) return renderer;
  // CLI help also loads the tracker from a tarball with no installed dependencies.
  const MarkdownIt = require("markdown-it");
  const markdown = MarkdownIt({ html: false, linkify: false });
  const escape = markdown.utils.escapeHtml;

  markdown.validateLink = () => true; // The renderer decides which parsed links may navigate.
  markdown.renderer.rules.image = (tokens, index, options, env, self) =>
    escape(self.renderInlineAsText(tokens[index].children, options, env));
  markdown.renderer.rules.link_open = (tokens, index, _options, env) => {
    const href = tokens[index].attrGet("href") ?? "";
    let target;
    if (href.startsWith("#")) {
      try { target = env.anchors.get(decodeURIComponent(href.slice(1))); }
      catch { /* An invalid fragment stays inert. */ }
    }
    const link = /^https?:\/\//i.test(href) && externalLinkAttributes(href, env.origin);
    if (target) {
      return `<a href="#${escape(target)}" data-artifact-heading="${escape(target)}">`;
    }
    if (link) return `<a href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">`;
    for (let next = index + 1; next < tokens.length; next++) {
      if (tokens[next].type !== "link_close") continue;
      tokens[next].tag = "span";
      break;
    }
    return "<span>";
  };
  renderer = markdown;
  return renderer;
}

export function artifactMarkdown(text, origin) {
  const markdown = markdownRenderer();
  const anchors = new Map(), suffixes = new Map(), headings = [];
  const env = { origin, anchors };
  const tokens = markdown.parse(text, env);
  for (const [index, token] of tokens.entries()) {
    if (["td_open", "th_open"].includes(token.type)) {
      const style = token.attrGet("style");
      const alignment = /^text-align:(left|center|right)$/.exec(style ?? "")?.[1];
      if (alignment) token.attrs.splice(token.attrIndex("style"), 1, ["class", `artifact-align-${alignment}`]);
    }
    if (token.type !== "heading_open") continue;
    const inline = tokens[index + 1];
    const label = inline.children.map(child => child.content).join("").trim() || "Section";
    const slug = headingSlug(label) || "section";
    let name = slug;
    if (anchors.has(name)) {
      let suffix = suffixes.get(slug) ?? 1;
      do { name = `${slug}-${suffix++}`; } while (anchors.has(name));
      suffixes.set(slug, suffix);
    }
    const id = `artifact-heading-${headings.length + 1}`;
    anchors.set(name, id);
    token.attrSet("id", id);
    token.attrSet("tabindex", "-1");
    headings.push({ id, label });
  }
  return { html: markdown.renderer.render(tokens, markdown.options, env), headings };
}
