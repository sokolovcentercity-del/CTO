import { state } from '../state.js';

function normalizeProgramValue(value) {
  return String(value || '').trim().toLowerCase();
}

export function getProgramByIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const direct = (state.programs || []).find((program) => {
    return [program?.name, program?.code, program?.kbk]
      .map(normalizeProgramValue)
      .includes(normalizeProgramValue(raw));
  });
  if (direct) return direct;

  const byLabel = (state.programs || []).find((program) => {
    return normalizeProgramValue(formatProgramLabel(program)) === normalizeProgramValue(raw);
  });
  return byLabel || null;
}

export function formatProgramLabel(programOrValue) {
  const program = typeof programOrValue === 'object' && programOrValue
    ? programOrValue
    : getProgramByIdentity(programOrValue);

  if (!program) {
    return String(programOrValue || '').trim();
  }

  const kbk = String(program.kbk || '').trim();
  const name = String(program.name || '').trim();
  const code = String(program.code || '').trim();

  let label = '';
  if (kbk && name) label = `${kbk}-${name}`;
  else label = name || kbk || code;

  if (code) {
    label = label ? `${label}-(${code})` : `(${code})`;
  }

  return label;
}
