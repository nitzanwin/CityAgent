import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "CityDesk | Voice Agent Prototype", description: "Threefold AI take-home prototype" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
