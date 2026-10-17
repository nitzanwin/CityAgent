import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "CityDesk | Voice Agent Prototype", description: "Threefold AI take-home prototype" };
export const viewport: Viewport = { themeColor: "#0b1820" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
