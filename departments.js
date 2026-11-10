// 部署一覧（「部署ごと」ページ・職員登録・お知らせの配信対象に共通で使う）
// seed.js の DEPARTMENTS に同名の部署があり、ここで課・病棟を定義していない部署（例：事務部）は seed の課を使う
// ここで課・病棟を定義している部署（例：看護部）は、この定義だけを使う
const PAGES = [
  { name: '医局', sections: [] },
  { name: '看護部', sections: ['外来', '3A', '3B', '4A', '4B'] },
  { name: '血液浄化室', sections: [] },
  { name: '臨床工学課', sections: [] },
  { name: '薬剤課', sections: [] },
  { name: '栄養課', sections: [] },
  { name: '検査課', sections: [] },
  { name: '放射線課', sections: [] },
  { name: '健康管理室', sections: [] },
  { name: '事務部', sections: [] },
  { name: 'リハビリテーション課', sections: [] },
  { name: '患者支援センター', sections: [] },
  { name: '訪問看護', sections: [] },
  { name: '在宅医療支援課', sections: [] },
];

function merge(seedDepartments) {
  const seed = Array.isArray(seedDepartments) ? seedDepartments : [];
  const out = PAGES.map((p) => {
    const s = seed.find((d) => d.name === p.name);
    return { name: p.name, sections: p.sections.length ? [...p.sections] : [...((s && s.sections) || [])] };
  });
  for (const s of seed) if (!out.some((d) => d.name === s.name)) out.push({ name: s.name, sections: [...(s.sections || [])] });
  return out;
}

module.exports = { PAGES, merge };
