function stripJsonCommentsOnly(json: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  let escaping = false;
  let lineComment = false;
  let blockComment = false;

  while (index < json.length) {
    const char = json[index]!;
    const next = json[index + 1];

    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output += char;
      }
      index += 1;
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 2;
      continue;
    }

    if (char === '/' && next === '*') {
      blockComment = true;
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function stripTrailingCommas(json: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  let escaping = false;

  while (index < json.length) {
    const char = json[index]!;

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (/\s/.test(json[lookahead] ?? '')) lookahead += 1;
      if (json[lookahead] === '}' || json[lookahead] === ']') {
        index += 1;
        continue;
      }
    }

    output += char;
    index += 1;
  }

  return output;
}

export function stripJsonComments(json: string): string {
  return stripTrailingCommas(stripJsonCommentsOnly(json));
}

export function parseJsonc<T = unknown>(content: string): T {
  return JSON.parse(stripJsonComments(content)) as T;
}
