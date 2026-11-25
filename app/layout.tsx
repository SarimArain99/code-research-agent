import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CodeLens — Code Research Agent",
  description:
    "Load a public GitHub repo and ask questions about its code. Answers cite real file:line locations, never general knowledge.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${grotesk.variable} ${inter.variable}`}>
      <body className="min-h-dvh bg-ink font-sans text-paper antialiased">
        {children}
      </body>
    </html>
  );
}
