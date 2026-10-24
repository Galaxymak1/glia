// Turn enrichment (SPEC.md, "Server-side parsing", steps 4 and 5): which text the harness
// injected rather than a person wrote, and the language of each turn. Pure functions.

/**
 * Part of every parser version: a change to the rules here bumps it, so the next ingest
 * re-parses every source and no turn keeps a flag or language from the old rules.
 */
export const ENRICH_VERSION = "enrich@1";

/**
 * Tags the harness wraps around text it adds to a user-role message: reminders, background
 * task notices, the output and caveat of a local slash command, hook output.
 */
const INJECTED_TAGS = ["system-reminder", "task-notification", "local-command-caveat", "local-command-stdout", "local-command-stderr", "user-prompt-submit-hook"];
const INJECTED_SPAN = new RegExp(String.raw`<(${INJECTED_TAGS.join("|")})>[\s\S]*?</\1>`, "g");

/**
 * Splits a user-role text into what its author wrote and the injected spans in it. A tag
 * left open is not a span: the text is kept as written.
 */
export function splitInjected(text: string): { own: string; injected: string[] } {
  const injected = text.match(INJECTED_SPAN) ?? [];
  if (!injected.length) return { own: text, injected };
  const own = text
    .replace(INJECTED_SPAN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { own, injected };
}

export type Lang = "fr" | "en" | "mixed";

// Function words of one language only: a word common to both (a, as, an, but, me, on, or,
// son, plus, ...) is in neither list, so it never tips a turn.
const FR = new Set(
  (
    "le la les l des du de un une et est sont pour dans avec sur pas que qui qu ce cette ces c mais où je j tu il elle nous vous ils elles " +
    "mon ma mes ton ta tes sa ses leur leurs au aux être avoir fait faire très aussi comme quand alors donc peut tout tous toute rien oui " +
    "merci bien sans chez entre ça cela voici voilà déjà encore après parce quoi comment pourquoi été était suis sommes êtes ont " +
    "y ne n se s d m t moi toi lui eux même faut veux veut peux vais va fais dis sais quel quelle ici chaque ouais"
  ).split(" "),
);
const EN = new Set(
  (
    "the and is are was were be been being of to in it that this with for not you i we they he she have has had do does did " +
    "if what which when how why there their my your our will would can could should from by at all so just about into than then them " +
    "also here its these those because after before where who any some yes it's don't i'm i've i'll you're doesn't can't isn't let's " +
    "want need please thanks yeah u ur im dont tho give get got make know think like way more much very well"
  ).split(" "),
);

// Code, links and paths say nothing about the language a turn is written in; nor do pasted
// blocks, tool calls (one `[tool_use <name>] <json>` line each) or attached files, which
// parsers append after an `[attachment <name>]` line.
const ATTACHMENTS = /(?:^|\n)\[attachment [^\]\n]*\][\s\S]*$/;
const NOT_PROSE = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>|^\[tool_use [^\]\n]*\].*$|```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|\S*[/\\]\S*/gm;

/** Below this many function words a text is too short or too technical to call: no language. */
const MIN_HITS = 2;
/** The smaller language must carry this share of the function words, and this many, for a turn to be mixed. */
const MIXED_SHARE = 0.2;
const MIXED_MIN_HITS = 4;

/**
 * The language of a turn: fr, en, mixed, or null when there is too little prose to tell.
 * Each sentence counts its French and English function words and goes to the language with
 * more; a turn whose smaller language holds a fifth of the words or more is mixed. Counting by
 * sentence keeps an English word quoted in a French sentence (or the reverse) from tipping it.
 */
export function detectLang(text: string): Lang | null {
  let fr = 0;
  let en = 0;
  for (const sentence of text.replace(ATTACHMENTS, "").replace(NOT_PROSE, " ").split(/[.!?;:\n]+/)) {
    let f = 0;
    let e = 0;
    // Elisions split off: l'erreur gives l, erreur; it's and don't stay whole.
    for (const word of sentence.toLowerCase().replace(/’/g, "'").match(/\p{L}+(?:'(?:s|t|m|ve|ll|re|d)\b)?/gu) ?? []) {
      if (FR.has(word)) f++;
      else if (EN.has(word)) e++;
    }
    if (f > e) fr += f + e;
    else if (e > f) en += f + e;
  }
  const total = fr + en;
  if (total < MIN_HITS) return null;
  const minority = Math.min(fr, en);
  if (minority >= MIXED_MIN_HITS && minority / total >= MIXED_SHARE) return "mixed";
  return fr > en ? "fr" : "en";
}
