export type DepartmentId = "public-works" | "parks" | "code-compliance" | "general";
export type Department = { id: DepartmentId; name: string; mockPhone: string; keywords: string[] };
export const city = {
  name: "Bellevue, Washington",
  timezone: "America/Los_Angeles",
  // Demo policy, not a verified city-wide schedule. Replace with published department-specific hours.
  weekdayOpenHour: 8,
  weekdayCloseHour: 16,
  sources: [
    { label: "City website", url: "https://bellevuewa.gov/" },
    { label: "Municipal code", url: "https://bellevue.municipal.codes/" },
    { label: "City calendar", url: "https://bellevuewa.gov/calendar" },
  ],
};
export const departments: Department[] = [
  { id: "public-works", name: "Public Works", mockPhone: "+1-555-0101", keywords: ["pothole", "road", "street", "water", "sewer", "traffic", "sidewalk", "drain"] },
  { id: "parks", name: "Parks & Recreation", mockPhone: "+1-555-0102", keywords: ["park", "playground", "trail", "recreation", "tree"] },
  { id: "code-compliance", name: "Code Compliance", mockPhone: "+1-555-0103", keywords: ["noise", "zoning", "permit", "violation", "construction", "code"] },
  { id: "general", name: "General Services", mockPhone: "+1-555-0104", keywords: [] },
];
