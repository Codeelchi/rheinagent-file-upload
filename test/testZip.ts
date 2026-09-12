import zlib from "node:zlib";

/**
 * Minimal ZIP writer, test-only. Builds a real, spec-valid ZIP buffer
 * (local file headers + central directory + end-of-central-directory)
 * without any dependency — mirrors the project's own "hand-roll the binary
 * format" style (see the PNG/JPEG builders in processors.test.ts). Not
 * named `*.test.ts` so `tsx --test test/*.test.ts` doesn't try to run it
 * as its own test file.
 */

export interface ZipEntrySpec {
  name: string;
  content: Buffer;
  /** "store" (no compression) or "deflate". Default "deflate". */
  method?: "store" | "deflate";
}

export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? "deflate";
    const compressionMethod = method === "store" ? 0 : 8;
    const data = method === "store" ? entry.content : zlib.deflateRawSync(entry.content);
    const nameBuf = Buffer.from(entry.name, "utf-8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (0 is fine, we never verify it)
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.content.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    const localEntry = Buffer.concat([localHeader, nameBuf, data]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(data.length, 20); // compressed size
    centralHeader.writeUInt32LE(entry.content.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // cd size
  eocd.writeUInt32LE(localData.length, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localData, centralDir, eocd]);
}

export const OOXML_DOCX_CONTENT_TYPES = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  "utf-8",
);

export const OOXML_XLSX_CONTENT_TYPES = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`,
  "utf-8",
);

export function sampleDocxDocumentXml(): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>Hello from a test DOCX document.</w:t></w:r></w:p>
<w:p><w:r><w:t>Second paragraph with &amp; an ampersand.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body>
</w:document>`,
    "utf-8",
  );
}

export function buildSampleDocx(): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", content: OOXML_DOCX_CONTENT_TYPES },
    { name: "word/document.xml", content: sampleDocxDocumentXml() },
  ]);
}

export function buildSampleXlsx(): Buffer {
  const workbookXml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets>
</workbook>`,
    "utf-8",
  );
  const sharedStringsXml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Name</t></si><si><t>Age</t></si><si><t>Alice</t></si></sst>`,
    "utf-8",
  );
  const worksheetXml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:B2"/>
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c></row>
</sheetData>
</worksheet>`,
    "utf-8",
  );
  return buildZip([
    { name: "[Content_Types].xml", content: OOXML_XLSX_CONTENT_TYPES },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/sharedStrings.xml", content: sharedStringsXml },
    { name: "xl/worksheets/sheet1.xml", content: worksheetXml },
  ]);
}
