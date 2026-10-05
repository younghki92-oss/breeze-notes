// Export Apple Notes to a folder that Breeze can import (설정 → 애플 노트 가져오기).
// Read-only: nothing in Apple Notes is changed.
//
//   osascript -l JavaScript tools/export-apple-notes.js ~/Downloads/apple-notes-export
//
// Output: <dir>/notes.json and <dir>/files/* (inline images and attachments).

ObjC.import('Foundation');

const IMAGE_EXT = /\.(png|jpe?g|gif|heic|heif|tiff?|webp|bmp)$/i;
const SKIP_FOLDERS = ['Recently Deleted', '최근 삭제된 항목'];

function run(argv) {
  const outDir = (argv[0] || '').replace(/\/+$/, '');
  if (!outDir) throw new Error('usage: osascript -l JavaScript export-apple-notes.js <output-dir>');
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(outDir + '/files'), true, $(), $());

  const Notes = Application('Notes');
  const out = [];
  const report = { notes: 0, images: 0, files: 0, links: 0, skippedDeleted: 0, locked: [], failedAttachments: [] };

  for (const account of Notes.accounts()) {
    const notes = account.notes();
    notes.forEach((note, i) => {
      if (i % 50 === 0) console.log(`${account.name()}: ${i}/${notes.length}`);
      const folder = note.container().name();
      if (SKIP_FOLDERS.includes(folder)) { report.skippedDeleted++; return; }
      if (note.passwordProtected()) { report.locked.push(note.name()); return; }

      const key = note.id().replace(/[^A-Za-z0-9]/g, '_').slice(-48);
      let k = 0;
      // Inline images arrive as data: URIs in the body HTML — write them out as files.
      const body = note.body().replace(/src="data:([\w/+.-]+);base64,([^"]+)"/g, (_m, mime, b64) => {
        const ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
        const path = `files/${key}_img${k++}.${ext}`;
        $.NSData.alloc.initWithBase64EncodedStringOptions($(b64), 1).writeToFileAtomically($(outDir + '/' + path), true);
        report.images++;
        return `src="${path}"`;
      });

      const attachments = [];
      note.attachments().forEach((a, j) => {
        const name = a.name() || `첨부${j + 1}`;
        let url = '';
        try { url = a.url() || ''; } catch (e) {}
        if (url) { attachments.push({ kind: 'link', url, name }); report.links++; return; }
        const isImage = IMAGE_EXT.test(name);
        if (isImage && k > 0) return; // already exported from the body
        const path = `files/${key}_a${j}_${name.replace(/[\/:\\]/g, '_')}`;
        try {
          Notes.save(a, { in: Path(outDir + '/' + path) });
          attachments.push({ kind: isImage ? 'image' : 'file', path, name });
          isImage ? report.images++ : report.files++;
        } catch (e) { report.failedAttachments.push(`${note.name()} — ${name}`); }
      });

      out.push({
        id: note.id(),
        folder,
        created: note.creationDate().getTime(),
        modified: note.modificationDate().getTime(),
        body,
        attachments,
      });
      report.notes++;
    });
  }

  // Browsers can't decode TIFF/HEIC everywhere — convert those to JPEG (max 2400px) with macOS's sips.
  const sh = Application.currentApplication();
  sh.includeStandardAdditions = true;
  const q = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
  for (const note of out) {
    const fix = (p) => {
      if (!/\.(tiff?|heic|heif|bmp)$/i.test(p)) return p;
      const jpg = p.replace(/\.[^.]+$/, '.jpg');
      try {
        sh.doShellScript(`sips -s format jpeg -Z 2400 ${q(outDir + '/' + p)} --out ${q(outDir + '/' + jpg)} >/dev/null && rm ${q(outDir + '/' + p)}`);
        return jpg;
      } catch (e) { return p; }
    };
    note.body = note.body.replace(/src="(files\/[^"]+)"/g, (_m, p) => `src="${fix(p)}"`);
    note.attachments.forEach((a) => { if (a.kind === 'image') a.path = fix(a.path); });
  }

  $(JSON.stringify({ app: 'apple-notes-export', version: 1, notes: out })).writeToFileAtomicallyEncodingError($(outDir + '/notes.json'), true, $.NSUTF8StringEncoding, null);
  return JSON.stringify(report, null, 1);
}
