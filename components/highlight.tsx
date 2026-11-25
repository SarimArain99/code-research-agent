import type { ReactNode } from "react";

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "extends", "import", "from", "export", "new", "await", "async",
  "try", "catch", "throw", "typeof", "instanceof", "of", "in", "switch",
  "case", "break", "continue", "default", "this", "super", "static",
  "public", "private", "protected", "interface", "type", "enum", "implements",
  "package", "def", "fn", "struct", "impl", "pub", "mut", "use", "mod",
  "nil", "true", "false", "null", "undefined", "void", "delete",
]);

const TOKEN_RE =
  /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][A-Za-z0-9_$]*)(?=\s*\()|\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

/** Minimal regex syntax highlighting. No external highlighter, no HTML injection. */
export function highlightLine(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) {
      nodes.push(line.slice(last, m.index));
    }
    const [whole, comment, blockComment, str, num, fnName, word] = m;
    if (comment || blockComment) {
      nodes.push(
        <span key={`${keyPrefix}-${k++}`} className="italic text-faint">
          {whole}
        </span>,
      );
    } else if (str) {
      nodes.push(
        <span key={`${keyPrefix}-${k++}`} className="text-code-amber">
          {whole}
        </span>,
      );
    } else if (num) {
      nodes.push(
        <span key={`${keyPrefix}-${k++}`} className="text-code-sky">
          {whole}
        </span>,
      );
    } else if (fnName) {
      nodes.push(
        <span key={`${keyPrefix}-${k++}`} className="text-code-sky">
          {whole}
        </span>,
      );
    } else if (word) {
      if (KEYWORDS.has(word)) {
        nodes.push(
          <span key={`${keyPrefix}-${k++}`} className="text-copper-soft">
            {whole}
          </span>,
        );
      } else {
        nodes.push(whole);
      }
    }
    last = m.index + whole.length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
}
