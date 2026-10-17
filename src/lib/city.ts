import { cityPack } from "../cities";

export type DepartmentId = string;
export type Department = { id: DepartmentId; name: string; covers: string; mockPhone: string; keywords: string[] };
// The active city's config (src/cities/<id>/city.json). Hours are a demo policy, not the city's published hours.
const { config } = cityPack();
export const city = config;
export const departments: Department[] = config.departments;
export const departmentName = (id: DepartmentId) => departments.find(d => d.id === id)?.name ?? "General Services";
