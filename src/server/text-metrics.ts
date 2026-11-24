import type { DiagramNodeSpec, NodeShape } from '../shared/dsl.js';

function charWidthFactor(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  // CJK / full-width punctuation / emoji
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    code >= 0x1f000
  ) {
    return 1.04;
  }
  if ('il1.,:;\'|! '.includes(ch)) return 0.36;
  if ('MW@#%&QG'.includes(ch)) return 0.78;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.57;
}

export function measureLineWidth(line: string, fontSize: number): number {
  let width = 0;
  for (const ch of line) {
    width += charWidthFactor(ch) * fontSize;
  }
  return Math.ceil(width);
}

export function wrapText(text: string, maxWidthPx: number, fontSize: number): string[] {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  const wrapped: string[] = [];

  for (const raw of rawLines) {
    if (!raw.trim()) {
      wrapped.push('');
      continue;
    }
    if (measureLineWidth(raw, fontSize) <= maxWidthPx) {
      wrapped.push(raw);
      continue;
    }

    let current = '';
    let currentWidth = 0;
    const tokens = raw.match(/\S+\s*|\s+/g) ?? [raw];

    for (const token of tokens) {
      const tokenWidth = measureLineWidth(token, fontSize);
      if (currentWidth + tokenWidth <= maxWidthPx) {
        current += token;
        currentWidth += tokenWidth;
      } else if (tokenWidth <= maxWidthPx && current.trim()) {
        wrapped.push(current.trimEnd());
        current = token.trimStart();
        currentWidth = measureLineWidth(current, fontSize);
      } else {
        // Character-level wrap (important for Chinese / long identifiers)
        for (const ch of token) {
          const cw = charWidthFactor(ch) * fontSize;
          if (currentWidth + cw > maxWidthPx && current.length > 0) {
            wrapped.push(current.trimEnd());
            current = ch === ' ' ? '' : ch;
            currentWidth = current ? cw : 0;
          } else {
            current += ch;
            currentWidth += cw;
          }
        }
      }
    }
    if (current.length > 0) {
      wrapped.push(current.trimEnd());
    }
  }

  return wrapped.length > 0 ? wrapped : [''];
}

export interface MeasuredNode {
  width: number;
  height: number;
  labelLines: string[];
  sublabelLines: string[];
  displayText: string;
}

export function measureNodeBox(node: DiagramNodeSpec): MeasuredNode {
  const shape: NodeShape = node.shape ?? 'rounded';
  const mainFontSize = shape === 'text' ? 20 : 16;
  const subFontSize = 12;
  const maxTextWidth = shape === 'note' ? 240 : shape === 'text' ? 420 : 210;

  const labelLines = wrapText(node.label || node.id, maxTextWidth, mainFontSize);
  const sublabelLines = node.sublabel ? wrapText(node.sublabel, maxTextWidth + 20, subFontSize) : [];

  let textW = 0;
  for (const l of labelLines) textW = Math.max(textW, measureLineWidth(l, mainFontSize));
  for (const l of sublabelLines) textW = Math.max(textW, measureLineWidth(l, subFontSize));

  const mainLineHeight = Math.round(mainFontSize * 1.35);
  const subLineHeight = Math.round(subFontSize * 1.35);
  const textH =
    labelLines.length * mainLineHeight +
    (sublabelLines.length > 0 ? 5 + sublabelLines.length * subLineHeight : 0);

  let width: number;
  let height: number;

  switch (shape) {
    case 'text':
      width = Math.max(60, textW + 16);
      height = Math.max(28, textH + 10);
      break;
    case 'diamond':
      // Diamond inscribed rectangle needs ~1.5x margin so corners don't clip text
      width = Math.max(140, Math.ceil(textW * 1.48) + 46);
      height = Math.max(88, Math.ceil(textH * 1.58) + 38);
      break;
    case 'ellipse':
      width = Math.max(130, Math.ceil(textW * 1.26) + 40);
      height = Math.max(64, Math.ceil(textH * 1.3) + 28);
      break;
    case 'database':
      width = Math.max(140, textW + 44);
      height = Math.max(76, textH + 46);
      break;
    case 'note':
      width = Math.max(170, textW + 40);
      height = Math.max(70, textH + 34);
      break;
    case 'queue':
      width = Math.max(150, textW + 52);
      height = Math.max(58, textH + 30);
      break;
    case 'rect':
    case 'rounded':
    default:
      width = Math.max(132, textW + 40);
      height = Math.max(56, textH + 28);
      break;
  }

  if (node.width && node.width > width) width = Math.ceil(node.width);
  if (node.height && node.height > height) height = Math.ceil(node.height);

  const displayText =
    sublabelLines.length > 0
      ? `${labelLines.join('\n')}\n${sublabelLines.join('\n')}`
      : labelLines.join('\n');

  return {
    width,
    height,
    labelLines,
    sublabelLines,
    displayText,
  };
}

export function measureEdgeLabel(label: string): {
  width: number;
  height: number;
  wrapped: string;
} {
  const fontSize = 13;
  const lines = wrapText(label, 160, fontSize);
  let maxW = 0;
  for (const l of lines) maxW = Math.max(maxW, measureLineWidth(l, fontSize));
  return {
    width: Math.max(28, maxW + 12),
    height: Math.max(20, lines.length * Math.round(fontSize * 1.3) + 6),
    wrapped: lines.join('\n'),
  };
}
