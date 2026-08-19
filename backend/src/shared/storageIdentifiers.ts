const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_KEY_SEGMENT_LENGTH = 128;

const parseStorageKeySegment = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }
  if (value.length > MAX_KEY_SEGMENT_LENGTH) {
    throw new Error(`${label} must be ${MAX_KEY_SEGMENT_LENGTH} characters or fewer.`);
  }
  if (!SAFE_KEY_SEGMENT.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return value;
};

export const parseStudentId = (value: unknown): string =>
  parseStorageKeySegment(value, "Student ID");

export const parseSessionId = (value: unknown): string =>
  parseStorageKeySegment(value, "Session ID");

export const parseSubmissionId = (value: unknown): string =>
  parseStorageKeySegment(value, "Submission ID");
