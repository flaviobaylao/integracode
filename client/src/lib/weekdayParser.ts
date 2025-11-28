/**
 * Robust weekday parsing utility
 * Handles multiple formats: JSON arrays, PostgreSQL arrays, comma-separated strings
 * NEVER throws - always returns valid result or empty array
 */

const VALID_WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];

/**
 * Safely parse weekdays from any format without throwing errors
 * @param input - Can be JSON string, PostgreSQL array, comma-separated string, or array
 * @returns Array of valid abbreviated weekdays (Seg, Ter, etc)
 */
export function safeParseWeekdays(input: any): string[] {
  if (!input) return [];

  let values: string[] = [];

  try {
    // If it's already an array
    if (Array.isArray(input)) {
      values = input.map(v => String(v || '').trim()).filter(v => v);
    } 
    // If it's a string
    else {
      const str = String(input || '').trim();
      if (!str) return [];

      // Try PostgreSQL array format first: {Seg,Ter}
      if (str.startsWith('{') && str.endsWith('}')) {
        const inner = str.slice(1, -1);
        values = inner.split(',').map(v => v.trim().replace(/^"|"$/g, '')).filter(v => v);
      } 
      // Try JSON array format: ["Seg","Ter"]
      else if ((str.startsWith('[') && str.endsWith(']')) || str.startsWith('"')) {
        try {
          const parsed = JSON.parse(str);
          values = (Array.isArray(parsed) ? parsed : [String(parsed)]).map(v => String(v || '').trim()).filter(v => v);
        } catch {
          // If JSON.parse fails, don't try other formats - return empty
          return [];
        }
      }
      // Comma-separated or other simple format
      else if (str.includes(',') || str.includes(';') || str.includes('/')) {
        values = str.split(/[,;/]/).map(v => v.trim()).filter(v => v);
      }
      // Single value
      else {
        values = [str];
      }
    }

    // Filter to only valid abbreviated weekdays
    return values.filter(v => VALID_WEEKDAYS.includes(v));
  } catch (error) {
    // Fail silently
    console.warn('Error parsing weekdays:', input, error);
    return [];
  }
}

/**
 * Join weekdays for display
 */
export function formatWeekdays(input: any): string {
  return safeParseWeekdays(input).join(', ');
}
