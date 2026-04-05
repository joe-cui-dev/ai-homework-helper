type Subject = "math" | "science" | "english" | "other";
type Year = "year-1" | "year-2" | "year-3" | "year-4" | "year-5" | "year-6";

// Abbreviated Australian Curriculum outcomes per subject and year level.
// Source: https://v9.australiancurriculum.edu.au
const CURRICULUM: Record<Subject, Record<Year, string[]>> = {
  math: {
    "year-1": [
      "Count, order, read and represent numbers to at least 120",
      "Add and subtract within 20 using concrete materials and strategies",
      "Recognise and describe simple patterns and sequences",
      "Measure and compare lengths using informal units",
    ],
    "year-2": [
      "Count, order, read and represent numbers to at least 1000",
      "Add and subtract two- and three-digit numbers using place value",
      "Describe, continue and create number patterns",
      "Recognise and interpret simple fractions (halves, quarters, eighths)",
    ],
    "year-3": [
      "Recall multiplication facts for 2, 3, 4, 5 and 10",
      "Add and subtract numbers up to and including four digits",
      "Explore and describe fractions, decimals and percentages",
      "Measure, order and compare objects using familiar metric units",
    ],
    "year-4": [
      "Recall multiplication and related division facts up to 10 × 10",
      "Apply mental strategies for multi-digit addition and subtraction",
      "Investigate equivalent fractions and relate fractions to decimals",
      "Solve problems involving area, perimeter and mass",
    ],
    "year-5": [
      "Solve problems involving multiplication and division of large numbers",
      "Compare, order and represent fractions, decimals and percentages",
      "Introduce negative numbers in context",
      "Calculate area and perimeter of rectangles and triangles",
    ],
    "year-6": [
      "Solve problems involving integers, fractions, decimals and percentages",
      "Introduce algebraic thinking using variables and equations",
      "Interpret and compare data using mean, median and mode",
      "Solve problems involving volume and surface area of 3D shapes",
    ],
  },
  science: {
    "year-1": [
      "Identify external features of plants and animals",
      "Describe daily and seasonal changes in the environment",
      "Explore the properties of everyday materials",
    ],
    "year-2": [
      "Describe how living things grow and change",
      "Investigate how light and sound behave",
      "Observe and compare weather patterns",
    ],
    "year-3": [
      "Investigate how and why things move",
      "Describe the life cycle of familiar animals",
      "Explore how materials can be mixed and separated",
    ],
    "year-4": [
      "Describe the role of adaptation in survival",
      "Investigate the properties of sound and light",
      "Explain the water cycle and its effect on the environment",
    ],
    "year-5": [
      "Describe changes that occur as substances interact",
      "Explain how forces affect the motion of objects",
      "Investigate the relationship between Earth, Moon and Sun",
    ],
    "year-6": [
      "Investigate electrical circuits and renewable energy sources",
      "Describe how the body's systems work together",
      "Explain biodiversity and the impact of human activity on ecosystems",
    ],
  },
  english: {
    "year-1": [
      "Blend phonemes to decode unfamiliar words",
      "Read and retell simple texts with literal comprehension",
      "Write simple sentences with correct punctuation",
    ],
    "year-2": [
      "Identify the main idea and supporting detail in a text",
      "Use noun groups, adjectives and verbs to add detail to writing",
      "Understand the difference between fiction and non-fiction texts",
    ],
    "year-3": [
      "Identify language features that build character and setting",
      "Use complex sentences to add detail and clarity to writing",
      "Explore how vocabulary choices create meaning in different text types",
    ],
    "year-4": [
      "Analyse how authors use language to influence the reader",
      "Write structured paragraphs with topic sentences and supporting detail",
      "Identify figurative language including similes, metaphors and alliteration",
    ],
    "year-5": [
      "Evaluate how author purpose and point of view shape a text",
      "Use varied sentence structures and punctuation for effect",
      "Analyse argument structure and identify persuasive techniques",
    ],
    "year-6": [
      "Compare how different texts represent the same topic or event",
      "Write persuasive and expository texts with evidence-based argument",
      "Discuss the effect of language choices on meaning and audience",
    ],
  },
  other: {
    "year-1": ["Apply logical thinking to solve simple problems"],
    "year-2": ["Break problems into steps and identify patterns"],
    "year-3": ["Evaluate multiple approaches to a problem"],
    "year-4": ["Use evidence to support reasoning and conclusions"],
    "year-5": ["Design and follow a systematic approach to problem solving"],
    "year-6": ["Reflect on strategies and consider alternative solutions"],
  },
};

export const lookupCurriculum = (subject: string, year: string): string[] => {
  const outcomes = CURRICULUM[subject as Subject]?.[year as Year];
  return outcomes ?? [];
};
