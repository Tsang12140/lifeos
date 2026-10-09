import { extractRawText } from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { HttpError } from "./http-kit.js";

export const MATERIAL_FORMATS: Readonly<Record<string, { extension: string; matches: (bytes: Buffer) => boolean }>> = {
  "application/pdf": { extension: ".pdf", matches: (b) => b.subarray(0, 5).toString() === "%PDF-" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { extension: ".docx", matches: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 },
  ...Object.fromEntries([["text/plain", ".txt"], ["text/markdown", ".md"], ["text/csv", ".csv"], ["application/json", ".json"]].map(([mime, extension]) => [mime!, { extension: extension!, matches: (b: Buffer) => !b.includes(0) }])),
};
export async function extractMaterialText(bytes: Buffer, mediaType: string): Promise<string> {
  if (bytes.length > 12 * 1024 * 1024) throw new HttpError(413, "material_too_large", "每个文档最多 12 MB，请拆分后选入");
  const format = MATERIAL_FORMATS[mediaType];
  if (!format || !format.matches(bytes)) throw new HttpError(415, "unsupported_material", "请选择文本、Markdown、CSV、JSON、PDF 或 Word（docx）材料");
  let result: string;
  try {
    if (mediaType === "application/pdf") {
      const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 200) throw new Error("PDF 页数超过 200 页，请拆分");
        const pages: string[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const content = await page.getTextContent();
          pages.push(content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join(""));
          page.cleanup();
          if (pages.reduce((sum, p) => sum + p.length, 0) > 80000) throw new Error("文档文字超过 8 万字，请拆分");
        }
        result = pages.join("\n\n");
      } finally { await task.destroy(); }
    } else if (format.extension === ".docx") {
      let expanded = 0, entries = 0;
      for (let i = 0; i + 46 <= bytes.length; i++) {
        if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
        expanded += bytes.readUInt32LE(i + 24); entries++;
        i += 45 + bytes.readUInt16LE(i + 28) + bytes.readUInt16LE(i + 30) + bytes.readUInt16LE(i + 32);
      }
      if (!entries || entries > 5000 || expanded > 40 * 1024 * 1024) throw new Error("Word 文件解压体积过大或格式损坏");
      result = (await extractRawText({ buffer: bytes })).value;
    } else result = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) { throw new HttpError(422, "material_read_failed", error instanceof Error ? `材料无法读取：${error.message}` : "材料无法读取"); }
  if (!result.trim()) throw new HttpError(422, "material_no_text", "没有读到文字。扫描版 PDF 请提供图片或粘贴文字");
  if (result.length > 80000) throw new HttpError(413, "material_too_large", "文档文字超过 8 万字，请拆分");
  return result.trim();
}
