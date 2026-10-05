export function splitWindowsArguments(value: string): string[] {
  if (!value) return [];
  const args: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (index >= value.length) break;

    let argument = '';
    let quoted = false;
    while (index < value.length) {
      if (!quoted && /\s/.test(value[index])) break;
      if (value[index] === '\\') {
        const start = index;
        while (value[index] === '\\') index += 1;
        const slashCount = index - start;
        if (value[index] === '"') {
          argument += '\\'.repeat(Math.floor(slashCount / 2));
          if (slashCount % 2 === 1) {
            argument += '"';
            index += 1;
          } else {
            quoted = !quoted;
            index += 1;
          }
        } else {
          argument += '\\'.repeat(slashCount);
        }
        continue;
      }
      if (value[index] === '"') {
        if (quoted && value[index + 1] === '"') {
          argument += '"';
          index += 2;
        } else {
          quoted = !quoted;
          index += 1;
        }
        continue;
      }
      argument += value[index];
      index += 1;
    }
    if (quoted) throw new Error('Application arguments contain an unmatched quote.');
    args.push(argument);
    while (index < value.length && /\s/.test(value[index])) index += 1;
  }
  return args;
}

export function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
