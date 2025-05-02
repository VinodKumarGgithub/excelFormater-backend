import { format, isValid, parse } from 'date-fns';

export function formatToDDMMYYYY(input) {
  if (input instanceof Date && isValid(input)) {
    return format(input, 'dd/MM/yyyy');
  }
  const knownFormats = [
    'dd/MM/yyyy hh:mm:ss a',
    'dd/MM/yyyy HH:mm:ss',
    'dd/MM/yyyy',
    'yyyy-MM-dd',
    'MM/dd/yyyy',
    'MMM dd, yyyy', // Mar 09, 2014
  ];

  for (const fmt of knownFormats) {
    const date = parse(input, fmt, new Date());
    if (isValid(date)) {
      return format(date, 'dd/MM/yyyy');
    }
  }

  const fallback = new Date(input);
  if (isValid(fallback)) {
    return format(fallback, 'dd/MM/yyyy');
  }

  return null;
} 