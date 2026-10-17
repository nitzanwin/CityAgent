import { cityPack } from "../cities";

export type DepartmentId = string;
export type Department = { id: DepartmentId; name: string; covers: string; phone: string; hours: string; keywords: string[] };
// The active city's config (src/cities/<id>/city.json): departments from its 311 data, contacts and hours from its website.
const { config } = cityPack();
export const city = config;
export const departments: Department[] = config.departments;
export const holidays: ReadonlySet<string> = new Set(config.holidays);
export const departmentName = (id: DepartmentId) => departments.find(d => d.id === id)?.name ?? departments.find(d => d.id === "general")!.name;
