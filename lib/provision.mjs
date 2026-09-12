/**
 * provision.mjs — 一键把云端运行环境部署到用户自己的 GitHub 仓库（零依赖 + 可选 sealedbox）
 *
 * 面板里点一下「一键部署云端」就完成：
 *   1. 校验 token
 *   2. 仓库不存在就创建（私有）
 *   3. 上传运行文件（report.mjs / cloud-dispatch.mjs / workflow / README）
 *   4. 写入密钥：优先 GitHub Actions Secrets；token 权限不够时自动回退成仓库内 env.json
 *   5. 写入变量（推送渠道、搜索 provider、模型、标题）
 *   6. 同步 tasks.json
 *   7. 可选：立刻触发一次 workflow 验证
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGitHub, readRepoFile, writeRepoFile } from './github.mjs';

const WORKFLOW_TARGET = '.github/workflows/daily-report.yml';

/** 需要上传到仓库的运行文件（runner 文件名 → 仓库内路径）。 */
const RUNNER_FILES = [
  ['report.mjs', 'report.mjs'],
  ['cloud-dispatch.mjs', 'cloud-dispatch.mjs'],
  ['README.md', 'README.md'],
  ['workflow-daily-report.yml', WORKFLOW_TARGET],
];

/** 动态加载 sealedbox：装了就能写 Secrets，没装则只能走 env.json 回退。 */
async function loadSealedBox() {
  try {
    const mod = await import('tweetnacl-sealedbox-js');
    return mod.default ?? mod;
  } catch {
    return undefined;
  }
}

function encryptSecret(sealedbox, publicKeyB64, value) {
  const sealed = sealedbox.seal(Buffer.from(value, 'utf8'), Buffer.from(publicKeyB64, 'base64'));
  return Buffer.from(sealed).toString('base64');
}

/**
 * 一键部署云端。
 * @param {object} options
 * @param {string} options.token            GitHub token（必填）
 * @param {string} [options.repoName]       仓库名，默认 dsh-cloud-report
 * @param {string} [options.branch]         分支，默认 main
 * @param {Record<string,string>} [options.secrets] 要写入 Actions Secrets 的键值
 * @param {Record<string,string>} [options.vars]    要写入 Actions Variables 的键值
 * @param {'auto'|'secrets'|'file'} [options.keyStore] 密钥落地方式
 * @param {string} options.runnerDir        运行文件所在目录
 * @param {object} [options.tasksPayload]   要写入仓库的 tasks.json 内容
 * @param {boolean} [options.dispatch]      部署完是否立刻触发一次运行
 * @returns {Promise<object>} 步骤日志与结果
 */
export async function provisionCloud(options) {
  const {
    token,
    repoName = 'dsh-cloud-report',
    branch = 'main',
    secrets = {},
    vars = {},
    keyStore = 'auto',
    runnerDir,
    tasksPayload,
    dispatch = false,
  } = options;

  const steps = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail: detail === undefined ? undefined : String(detail).slice(0, 400) });
    return ok;
  };

  if (!token) return { ok: false, error: '缺少 GitHub token', steps };

  const gh = createGitHub(token);

  // 1) 身份
  let owner;
  try {
    const me = await gh.api('/user');
    owner = me.login;
    step('校验 token', true, `已认证：${owner}`);
  } catch (error) {
    step('校验 token', false, error);
    return { ok: false, error: `token 校验失败：${String(error).slice(0, 200)}`, steps };
  }

  // 2) 仓库
  let repo;
  let created = false;
  try {
    repo = await gh.api(`/repos/${owner}/${repoName}`);
    step('检查仓库', true, `已存在：${repo.full_name}`);
  } catch (error) {
    if (!String(error).includes('404')) {
      step('检查仓库', false, error);
      return { ok: false, error: `读取仓库失败：${String(error).slice(0, 200)}`, steps };
    }
    try {
      repo = await gh.api('/user/repos', {
        method: 'POST',
        body: {
          name: repoName,
          private: true,
          auto_init: true,
          description: 'DSH 云端定时简报：联网检索 → DeepSeek 总结 → 推送到手机',
        },
      });
      created = true;
      step('创建仓库', true, `已创建私有仓：${repo.full_name}`);
    } catch (error2) {
      step('创建仓库', false, error2);
      return { ok: false, error: `创建仓库失败（token 需要 repo/Administration 写权限）：${String(error2).slice(0, 200)}`, steps };
    }
  }
  const full = `${owner}/${repoName}`;
  const targetBranch = branch || repo.default_branch || 'main';

  // 3) 运行文件
  const uploaded = [];
  let uploadFailed;
  for (const [local, remote] of RUNNER_FILES) {
    try {
      const content = await readFile(join(runnerDir, local), 'utf8');
      await writeRepoFile(gh, owner, repoName, remote, targetBranch, content, `chore: 更新 ${remote}`);
      uploaded.push(remote);
    } catch (error) {
      uploadFailed = `${remote}: ${String(error).slice(0, 160)}`;
      break;
    }
  }
  if (!step('上传运行文件', uploaded.length === RUNNER_FILES.length, uploadFailed ?? uploaded.join(', '))) {
    return { ok: false, error: `上传运行文件失败：${uploadFailed}`, steps, owner, repo: repoName, branch: targetBranch };
  }

  // 4) 密钥
  const secretEntries = Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v.trim().length > 0);
  let storeUsed;
  const sealedbox = await loadSealedBox();
  const wantSecrets = keyStore !== 'file';
  let secretsError;
  if (wantSecrets && secretEntries.length > 0) {
    if (!sealedbox) {
      secretsError = '本机没装 tweetnacl-sealedbox-js（无法加密 Secrets）';
    } else {
      try {
        const pub = await gh.api(`/repos/${full}/actions/secrets/public-key`);
        for (const [name, value] of secretEntries) {
          await gh.api(`/repos/${full}/actions/secrets/${name}`, {
            method: 'PUT',
            body: { encrypted_value: encryptSecret(sealedbox, pub.key, value.trim()), key_id: pub.key_id },
          });
        }
        storeUsed = 'secrets';
        step('写入 Actions Secrets', true, `${secretEntries.map(([k]) => k).join(', ')}（${secretEntries.length} 项）`);
      } catch (error) {
        secretsError = String(error).slice(0, 200);
      }
    }
  }

  if (storeUsed !== 'secrets' && secretEntries.length > 0 && keyStore !== 'secrets') {
    // 回退：把密钥写进仓库 env.json（workflow 会读取；私有仓才建议）
    const body = secretEntries.map(([k, v]) => `${k}=${v.trim()}`).join('\n') + '\n';
    try {
      await writeRepoFile(gh, owner, repoName, 'env.json', targetBranch, body, 'chore: 更新 env.json（密钥回退存储）');
      storeUsed = 'file';
      step('写入仓库 env.json', true, `Secrets 不可用（${secretsError ?? '未请求'}）→ 已回退为仓库内 env.json`);
    } catch (error) {
      step('写入仓库 env.json', false, error);
      return { ok: false, error: `密钥写入失败：Secrets 与 env.json 都不可用（${secretsError ?? ''} / ${String(error).slice(0, 160)}）`, steps, owner, repo: repoName, branch: targetBranch };
    }
  } else if (storeUsed === 'secrets' && secretEntries.length === 0) {
    storeUsed = 'none';
  }

  // 5) 变量
  const varEntries = Object.entries(vars).filter(([, v]) => typeof v === 'string' && v.length > 0);
  const varResults = [];
  for (const [name, value] of varEntries) {
    try {
      try {
        await gh.api(`/repos/${full}/actions/variables/${name}`, { method: 'PATCH', body: { name, value } });
      } catch (error) {
        if (!String(error).includes('404')) throw error;
        await gh.api(`/repos/${full}/actions/variables`, { method: 'POST', body: { name, value } });
      }
      varResults.push(name);
    } catch (error) {
      varResults.push(`${name}✗`);
    }
  }
  step('写入仓库变量', varResults.length === 0 || varResults.every((n) => !n.endsWith('✗')), varResults.join(', ') || '（无需写入）');

  // 6) 任务表
  if (tasksPayload) {
    try {
      await writeRepoFile(gh, owner, repoName, 'tasks.json', targetBranch, `${JSON.stringify(tasksPayload, null, 2)}\n`, `chore: 同步云端任务（${tasksPayload.tasks?.length ?? 0} 个）`);
      step('同步任务表', true, `${tasksPayload.tasks?.length ?? 0} 个云端任务`);
    } catch (error) {
      step('同步任务表', false, error);
    }
  }

  // 7) 触发一次
  let dispatched;
  if (dispatch) {
    try {
      const workflows = await gh.api(`/repos/${full}/actions/workflows`);
      const target = (workflows.workflows ?? []).find((w) => w.path.includes('daily-report')) ?? (workflows.workflows ?? [])[0];
      if (!target) throw new Error('仓库里还没有可用的 workflow（GitHub 索引可能要等十几秒）');
      await gh.api(`/repos/${full}/actions/workflows/${target.id}/dispatches`, { method: 'POST', body: { ref: targetBranch } });
      dispatched = true;
      step('触发一次运行', true, `${target.name ?? target.path} 已触发`);
    } catch (error) {
      step('触发一次运行', false, error);
    }
  }

  return {
    ok: true,
    steps,
    owner,
    repo: repoName,
    branch: targetBranch,
    repoUrl: repo.html_url ?? `https://github.com/${full}`,
    created,
    uploaded,
    keyStoreUsed: storeUsed ?? 'none',
    secretsError,
    dispatched,
  };
}

/** 只做「读取仓库状态」，用于面板显示是否已部署。 */
export async function inspectCloud(token, owner, repoName, branch = 'main') {
  if (!token || !owner || !repoName) return { connected: false };
  const gh = createGitHub(token);
  if (!owner) {
    const me = await gh.api('/user');
    owner = me.login;
  }
  const out = { connected: true, owner, repo: repoName };
  try {
    const repoInfo = await gh.api(`/repos/${owner}/${repoName}`);
    out.repoUrl = repoInfo.html_url;
    out.private = repoInfo.private === true;
    out.defaultBranch = repoInfo.default_branch || branch;
    const runner = await readRepoFile(gh, owner, repoName, 'cloud-dispatch.mjs', out.defaultBranch);
    const workflow = await readRepoFile(gh, owner, repoName, WORKFLOW_TARGET, out.defaultBranch);
    const envFile = await readRepoFile(gh, owner, repoName, 'env.json', out.defaultBranch);
    out.deployed = Boolean(runner && workflow);
    out.keyStore = envFile ? 'file' : 'unknown';
    out.ok = true;
  } catch (error) {
    out.ok = false;
    out.error = String(error).slice(0, 300);
  }
  return out;
}
