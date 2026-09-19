const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
for (const page of ['index.html','analysis.html','planning.html','settings.html','activity.html','upload.html','plan/index.html']) {
  test(`${page}: inline and shared scripts have no syntax or global declaration collisions`, () => {
    const html = fs.readFileSync(path.join(root,page),'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map(([,attrs,inline]) => {
      const src = attrs.match(/src=["']([^"']+)["']/)?.[1];
      if (!src) return inline;
      if (/^(https?:)?\/\//.test(src)) return '';
      return fs.readFileSync(path.resolve(path.dirname(path.join(root,page)),src),'utf8');
    });
    new vm.Script(scripts.join('\n;\n'),{filename:page});
  });
}
