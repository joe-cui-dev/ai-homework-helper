const SUBJECT_COLOURS: Record<string, string> = {
  math: "bg-blue-100 text-blue-700",
  maths: "bg-blue-100 text-blue-700",
  mathematics: "bg-blue-100 text-blue-700",
  english: "bg-green-100 text-green-700",
  science: "bg-purple-100 text-purple-700",
  history: "bg-orange-100 text-orange-700",
  geography: "bg-teal-100 text-teal-700",
};

export function subjectColour(subject: string): string {
  return SUBJECT_COLOURS[subject.toLowerCase()] ?? "bg-gray-100 text-gray-600";
}
