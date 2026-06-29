import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'faustinpataule12-art';
const REPO = 'NPS.NELSON';
const BRANCH = 'main';
const BASE = '/home/runner/workspace';

const EXCLUDE = [
  '.git', 'node_modules', '.pnpm-store', 'dist', '.local',
  'attached_assets', '.tsbuildinfo', 'pnpm-lock.yaml'
];

function shouldExclude(filePath) {
  const rel = path.relative(BASE, filePath);
  return EXCLUDE.some(ex => rel.includes(ex) || rel.endsWith(ex));
}

function getAllFiles(dir) {
  const results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (!EXCLUDE.includes(item.name)) {
        results.push(...getAllFiles(full));
      }
    } else if (!shouldExclude(full)) {
      results.push(full);
    }
  }
  return results;
}

async function apiCall(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `token ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.github.com${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok && res.status !== 422) {
    console.error(`API error ${res.status} for ${endpoint}:`, JSON.stringify(data).substring(0, 200));
  }
  return { status: res.status, data };
}

async function createBlob(content, encoding = 'base64') {
  const { data } = await apiCall(`/repos/${OWNER}/${REPO}/git/blobs`, 'POST', { content, encoding });
  return data.sha;
}

async function main() {
  console.log('Getting current remote commit SHA...');
  const { data: refData } = await apiCall(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`);
  const parentSha = refData.object?.sha;
  console.log('Remote parent SHA:', parentSha);

  const { data: commitData } = await apiCall(`/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
  const baseTreeSha = commitData.tree?.sha;
  console.log('Base tree SHA:', baseTreeSha);

  const files = getAllFiles(BASE);
  console.log(`Found ${files.length} files to push`);

  const treeItems = [];
  let count = 0;

  for (const filePath of files) {
    const rel = path.relative(BASE, filePath);
    const rawContent = fs.readFileSync(filePath);
    const b64 = rawContent.toString('base64');

    try {
      const sha = await createBlob(b64);
      treeItems.push({
        path: rel,
        mode: '100644',
        type: 'blob',
        sha
      });
      count++;
      if (count % 10 === 0) console.log(`  Uploaded ${count}/${files.length} files...`);
    } catch (err) {
      console.error(`  Failed to create blob for ${rel}:`, err.message);
    }
  }

  console.log(`Creating tree with ${treeItems.length} items...`);
  const { data: treeData } = await apiCall(`/repos/${OWNER}/${REPO}/git/trees`, 'POST', {
    base_tree: baseTreeSha,
    tree: treeItems
  });
  console.log('Tree SHA:', treeData.sha);

  console.log('Creating commit...');
  const { data: newCommit } = await apiCall(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', {
    message: 'Push Replit project to NPS.NELSON',
    tree: treeData.sha,
    parents: [parentSha]
  });
  console.log('New commit SHA:', newCommit.sha);

  console.log('Updating branch reference (force)...');
  const { status, data: updateData } = await apiCall(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, 'PATCH', {
    sha: newCommit.sha,
    force: true
  });
  if (status === 200) {
    console.log('SUCCESS! Branch updated to:', updateData.object?.sha);
    console.log(`View at: https://github.com/${OWNER}/${REPO}`);
  } else {
    console.error('Failed to update ref:', JSON.stringify(updateData));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
