export type InputContractProperty = {
  readonly type?: string | readonly string[];
  readonly description?: string;
};

export interface InputContract {
  readonly properties: Readonly<Record<string, InputContractProperty>>;
  readonly required?: readonly string[];
}

export type InputContractCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly string[] };

export function checkInputContract(
  input: Record<string, unknown>,
  contract: InputContract | undefined,
): InputContractCheckResult {
  const required = contract?.required ?? [];
  if (required.length === 0) return { ok: true };

  const missing = required.filter((field) => {
    const value = input[field];
    if (value === null || value === undefined) return true;
    if (typeof value === 'string' && value.trim().length === 0) return true;
    return false;
  });

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export function formatContractError(
  capability: string,
  contract: InputContract,
  missing: readonly string[],
): string {
  const required = new Set(contract.required ?? []);
  const expected = Object.entries(contract.properties)
    .map(([name, property]) => {
      const type = formatPropertyType(property.type);
      const requiredLabel = required.has(name) ? ', required' : '';
      const description = property.description ? ` — ${property.description}` : '';
      return `- ${name} (${type}${requiredLabel})${description}`;
    })
    .join('\n');

  return (
    `${capability}: missing required input: ${missing.join(', ')}.\n` +
    `Expected input contract:\n${expected}`
  );
}

function formatPropertyType(type: InputContractProperty['type']): string {
  if (typeof type === 'string') return type;
  if (type) return type.join('|');
  return 'unknown';
}
