export function fixtureUserPrompt(messages) {
  for (const message of [...(messages ?? [])].reverse()) {
    if (message.role !== 'user') continue;
    const prompt = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.map(part => part.text || '').join('\n') : '';
    if (/^<system-reminder>\r?\nMCP servers? connected:\r?\n[\s\S]*<\/system-reminder>$/.test(prompt.trim())) continue;
    return prompt;
  }
  return '';
}
