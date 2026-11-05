import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANGS, stepText, t, setLang } from '../../src/concierge/i18n.js';
import { walkSteps, formatDistance, formatDuration } from '../../src/concierge/services.js';

// Real OSRM answers for two walks from the hotel (fixtures/walk-*.json, 5 Nov 2026).
const DEST = { 'san-nicolas': 'Mirador de San Nicolás', catedral: 'Catedral de Granada' };
const fixtures = Object.keys(DEST).map((id) => ({ id, ...JSON.parse(readFileSync(new URL(`./fixtures/walk-${id}.json`, import.meta.url), 'utf8')) }));
// Words that only belong to another language's sentences.
const LEAK = { es: /\b(Turn|Continue|Head|Arrive|onto)\b/, fr: /\b(Turn|Continue|Head|Arrive|onto|Gire)\b/, de: /\b(Turn|Continue|Head|Arrive|onto|Gire)\b/, en: /\b(Gire|Siga|Salga|por)\b/ };

for (const f of fixtures)
  for (const lang of LANGS)
    test(`walking hotel → ${f.id}: every step reads well in ${lang}`, () => {
      setLang(lang);
      const steps = walkSteps(f.steps, { dest: DEST[f.id], lang });
      assert.ok(steps.length >= 5 && steps.length < f.steps.length, `${f.steps.length} raw steps → ${steps.length}`);
      const total = f.steps.reduce((a, s) => a + s.distanceM, 0);
      assert.equal(Math.round(steps.reduce((a, s) => a + s.distanceM, 0)), Math.round(total), 'folding must not lose distance');
      steps.forEach((s, i) => {
        const where = `${lang} step ${i + 1} (${s.type}/${s.modifier}): "${s.instruction}"`;
        assert.ok(s.instruction.length >= 8, where);
        assert.doesNotMatch(s.instruction, /undefined|null|NaN|\{|\}|  |\s$|\s(por|onto|sur|auf)$/, where);
        assert.doesNotMatch(s.instruction, LEAK[lang], where);
        assert.match(s.instruction[0], /[A-ZÀ-Ý]/, where);
        if (i < steps.length - 1) {
          assert.ok(s.distanceM >= 10, `${where}: a ${s.distanceM} m hop was left on its own`);
          assert.match(formatDistance(s.distanceM, t), /^\d+ m$|^\d+\.\d km$/, where);
          assert.match(formatDuration(s.durationS, t), /^\d+ (min|Min\.)$/, where);
        }
      });
      assert.equal(steps[0].type, 'depart');
      assert.equal(steps.at(-1).type, 'arrive');
      assert.ok(steps.at(-1).instruction.includes(DEST[f.id]), steps.at(-1).instruction);
    });

test('every OSRM maneuver has a sentence in the four languages, with the road when there is one', () => {
  const types = ['depart', 'arrive', 'turn', 'new name', 'continue', 'end of road', 'fork', 'merge', 'on ramp', 'off ramp', 'roundabout', 'rotary', 'roundabout turn', 'exit roundabout', 'use lane', 'notification'];
  const mods = [null, 'left', 'right', 'slight left', 'sharp right', 'straight', 'uturn'];
  for (const lang of LANGS)
    for (const type of types)
      for (const modifier of mods)
        for (const name of ['', 'Calle Elvira']) {
          const s = stepText({ type, modifier, name, exit: 2 }, { lang, dest: 'La Alhambra' });
          assert.ok(s.length >= 6 && !/undefined|\{|\}|  |\s$/.test(s), `${lang} ${type}/${modifier}/${name}: "${s}"`);
          if (name && type !== 'arrive') assert.ok(s.includes('Calle Elvira'), `${lang} ${type}/${modifier}: road missing in "${s}"`);
        }
  assert.equal(stepText({ type: 'roundabout', exit: 2, name: 'Gran Vía' }, { lang: 'es' }), 'En la rotonda, tome la 2.ª salida por Gran Vía');
  assert.equal(stepText({ type: 'turn', modifier: 'left', name: 'Calle Elvira' }, { lang: 'en' }), 'Turn left onto Calle Elvira');
  assert.equal(stepText({ type: 'end of road', modifier: 'right', name: 'Rue Haute' }, { lang: 'fr' }), 'Au bout de la rue, tournez à droite sur Rue Haute');
  assert.equal(stepText({ type: 'arrive', modifier: 'right' }, { lang: 'de', dest: 'Alhambra' }), 'Sie haben Alhambra erreicht, rechts');
  assert.equal(stepText({ type: 'depart' }, { lang: 'es' }), 'Salga del hotel');
});
