// ==UserScript==
// @name         Bilibili 收藏夹按 UP 主数量自动整理
// @namespace    https://github.com/
// @version      1.4.0
// @description  输入多个收藏夹名称，按 UP 主出现次数降序将视频移动到新建收藏夹
// @author       codex
// @match        https://space.bilibili.com/*/favlist*
// @grant        none
// ==/UserScript==

(async function main() {
  'use strict';

  const CONFIG = {
    pageSize: 20,
    maxPage: 1000,
    maxFolderSize: 1000,
    maxFolderNameLength: 20,
    moveDelayMs: 350,
    maxRetry: 3,
    defaultNewFolderNamePrefix: 'UP聚合',
    defaultTargetFolderSize: 1000,
  };

  const UI_ID = {
    launcher: 'fav-sort-launcher',
    overlay: 'fav-sort-overlay',
  };

  const log = (...args) => console.log('[FavSort]', ...args);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getCsrf() {
    const match = document.cookie.match(/(?:^|; )bili_jct=([^;]+)/);
    if (!match) {
      throw new Error('未检测到 bili_jct，需先登录并在 B 站页面运行。');
    }
    return decodeURIComponent(match[1]);
  }

  function getMyMid() {
    const match = location.pathname.match(/\/(\d+)\/favlist/);
    if (match) return match[1];

    const uidFromMeta = document.querySelector('meta[name="spm_prefix"]')?.content;
    if (uidFromMeta && /^\d+$/.test(uidFromMeta)) return uidFromMeta;

    throw new Error('无法从当前页面识别 mid，请在“我的收藏夹”页面运行。');
  }

  async function requestJson(url, init = {}) {
    const response = await fetch(url, {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json, text/plain, */*',
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}`);
    }

    const data = await response.json();
    if (typeof data.code !== 'number') {
      throw new Error(`接口返回异常（缺少 code）：${url}`);
    }
    if (data.code !== 0) {
      throw new Error(`接口错误 code=${data.code}, message=${data.message || data.msg || '未知'}: ${url}`);
    }

    return data;
  }

  async function fetchCreatedFolders(mid) {
    const url = `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}&type=2&rid=0`;
    const data = await requestJson(url);
    return data.data?.list || [];
  }

  async function fetchFolderResources(mediaId, folderTitle = '') {
    const all = [];
    const seen = new Set();
    let pn = 1;
    let expectedCount = null;

    while (pn <= CONFIG.maxPage) {
      const params = new URLSearchParams({
        media_id: String(mediaId),
        pn: String(pn),
        ps: String(CONFIG.pageSize),
        keyword: '',
        order: 'mtime',
        type: '0',
        tid: '0',
        platform: 'web',
      });

      const url = `https://api.bilibili.com/x/v3/fav/resource/list?${params.toString()}`;
      const data = await requestJson(url);

      const page = data.data || {};
      const medias = Array.isArray(page.medias) ? page.medias : [];
      const info = page.info || {};
      const mediaCount = Number(info.media_count || 0);
      expectedCount = Number.isFinite(mediaCount) ? mediaCount : expectedCount;

      for (const media of medias) {
        const resourceId = String(media?.id || '');
        if (!resourceId || seen.has(resourceId)) continue;
        seen.add(resourceId);
        all.push(media);
      }

      const hasMoreByFlag = Boolean(page.has_more);
      const hasMoreByCount = Number.isFinite(expectedCount) ? all.length < expectedCount : medias.length > 0;

      if (!hasMoreByFlag && !hasMoreByCount) break;
      if (medias.length === 0) break;

      pn += 1;
    }

    if (pn > CONFIG.maxPage) {
      throw new Error(`分页超过上限(${CONFIG.maxPage})，已终止，疑似接口异常。`);
    }

    if (Number.isFinite(expectedCount) && expectedCount > all.length) {
      log(`警告：收藏夹「${folderTitle || mediaId}」接口声明 ${expectedCount} 条，实际读取 ${all.length} 条。`);
    }

    return { medias: all, expectedCount };
  }

  async function createFolder(title, csrf) {
    const body = new URLSearchParams({
      title,
      intro: '按UP主视频数量自动聚合',
      privacy: '0',
      cover: '',
      csrf,
    });

    const data = await requestJson('https://api.bilibili.com/x/v3/fav/folder/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: body.toString(),
    });

    const mediaId = data.data?.id;
    if (!mediaId) {
      throw new Error('新收藏夹创建成功但未返回 media_id。');
    }

    return mediaId;
  }

  async function moveResource(srcMediaId, dstMediaId, media, csrf) {
    const resource = `${media.id}:2`;
    const body = new URLSearchParams({
      src_media_id: String(srcMediaId),
      tar_media_id: String(dstMediaId),
      resources: resource,
      platform: 'web',
      csrf,
    });

    await requestJson('https://api.bilibili.com/x/v3/fav/resource/move', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: body.toString(),
    });
  }

  function pickFoldersByName(allFolders, inputNames) {
    const normalize = (s) => s.trim().toLowerCase();
    const wanted = new Set(inputNames.map(normalize));
    const selected = allFolders.filter((f) => wanted.has(normalize(f.title || '')));

    const found = new Set(selected.map((f) => normalize(f.title || '')));
    const missing = inputNames.filter((name) => !found.has(normalize(name)));

    return { selected, missing };
  }

  function truncateName(title, maxLength = CONFIG.maxFolderNameLength) {
    return String(title || '').slice(0, maxLength);
  }

  function buildTargetFolderName(baseName, index, total) {
    const base = truncateName(baseName || CONFIG.defaultNewFolderNamePrefix, CONFIG.maxFolderNameLength).trim() || CONFIG.defaultNewFolderNamePrefix;
    if (total <= 1) return base;

    const suffix = `-${index + 1}`;
    const maxBaseLength = Math.max(1, CONFIG.maxFolderNameLength - suffix.length);
    return `${truncateName(base, maxBaseLength)}${suffix}`;
  }

  function buildUploaderGroups(items) {
    const groupMap = new Map();

    for (const item of items) {
      const upMid = String(item.media?.upper?.mid || '0');
      if (!groupMap.has(upMid)) {
        groupMap.set(upMid, {
          upMid,
          upName: String(item.media?.upper?.name || upMid),
          items: [],
        });
      }
      groupMap.get(upMid).items.push(item);
    }

    const groups = Array.from(groupMap.values());

    for (const group of groups) {
      group.items.sort((a, b) => Number(b.media?.fav_time || 0) - Number(a.media?.fav_time || 0));
      group.count = group.items.length;
    }

    groups.sort((a, b) => {
      const countDiff = b.count - a.count;
      if (countDiff !== 0) return countDiff;
      return a.upName.localeCompare(b.upName, 'zh-Hans-CN');
    });

    return groups;
  }

  function buildFolderChunks(groups, maxFolderSize) {
    const chunks = [];
    let current = { groups: [], total: 0 };

    for (const group of groups) {
      if (group.count > maxFolderSize) {
        throw new Error(`UP主「${group.upName}」单独就有 ${group.count} 个视频，超过单收藏夹上限 ${maxFolderSize}，无法做到完全不拆分。`);
      }

      if (current.total > 0 && current.total + group.count > maxFolderSize) {
        chunks.push(current);
        current = { groups: [], total: 0 };
      }

      current.groups.push(group);
      current.total += group.count;
    }

    if (current.total > 0) {
      chunks.push(current);
    }

    return chunks;
  }

  async function withRetry(action, label) {
    let lastError;
    for (let i = 1; i <= CONFIG.maxRetry; i += 1) {
      try {
        return await action();
      } catch (err) {
        lastError = err;
        log(`${label} 失败，第 ${i}/${CONFIG.maxRetry} 次`, err.message || err);
        await sleep(500 * i);
      }
    }
    throw new Error(`${label} 连续失败：${lastError?.message || lastError}`);
  }

  function parseFolderNames(rawInput) {
    return rawInput
      .split(/[，,\n\r;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function injectStyle() {
    const styleId = 'fav-sort-style';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #${UI_ID.launcher} {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 999999;
        border: none;
        border-radius: 999px;
        padding: 12px 18px;
        color: #fff;
        font-weight: 700;
        font-size: 14px;
        cursor: pointer;
        background: linear-gradient(135deg, #fb7299, #fc8bab);
        box-shadow: 0 10px 24px rgba(251, 114, 153, .35);
      }
      #${UI_ID.overlay} {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        background: rgba(0, 0, 0, .45);
        backdrop-filter: blur(2px);
      }
      #${UI_ID.overlay}.show { display: flex; }
      .fav-sort-panel {
        width: min(620px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow: auto;
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 20px 56px rgba(0, 0, 0, .22);
        border: 1px solid #f0f0f0;
      }
      .fav-sort-head {
        padding: 18px 20px;
        border-bottom: 1px solid #f3f3f3;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .fav-sort-head h3 {
        margin: 0;
        font-size: 18px;
        color: #222;
      }
      .fav-sort-close {
        border: none;
        background: #f5f5f5;
        border-radius: 10px;
        width: 32px;
        height: 32px;
        cursor: pointer;
      }
      .fav-sort-body { padding: 18px 20px 20px; }
      .fav-sort-field { margin-bottom: 14px; }
      .fav-sort-label {
        display: block;
        font-size: 13px;
        color: #666;
        margin-bottom: 6px;
      }
      .fav-sort-input, .fav-sort-textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #e5e7eb;
        background: #fafafa;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 14px;
        outline: none;
      }
      .fav-sort-input:focus, .fav-sort-textarea:focus {
        border-color: #fb7299;
        background: #fff;
      }
      .fav-sort-textarea { min-height: 92px; resize: vertical; }
      .fav-sort-hint { font-size: 12px; color: #888; margin-top: 4px; }
      .fav-sort-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        margin-top: 4px;
      }
      .fav-sort-btn {
        border: none;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 14px;
        cursor: pointer;
      }
      .fav-sort-btn-secondary { background: #f3f4f6; color: #333; }
      .fav-sort-btn-primary {
        color: #fff;
        font-weight: 700;
        background: linear-gradient(135deg, #fb7299, #fc8bab);
      }
      .fav-sort-status {
        margin-top: 10px;
        font-size: 13px;
        color: #555;
      }
    `;
    document.head.appendChild(style);
  }

  function createControlPanel(onStart) {
    if (document.getElementById(UI_ID.launcher) || document.getElementById(UI_ID.overlay)) {
      return;
    }

    injectStyle();

    const launcher = document.createElement('button');
    launcher.id = UI_ID.launcher;
    launcher.type = 'button';
    launcher.textContent = '收藏夹智能整理';

    const overlay = document.createElement('div');
    overlay.id = UI_ID.overlay;
    overlay.innerHTML = `
      <div class="fav-sort-panel">
        <div class="fav-sort-head">
          <h3>B站收藏夹智能整理</h3>
          <button class="fav-sort-close" type="button" title="关闭">✕</button>
        </div>
        <div class="fav-sort-body">
          <div class="fav-sort-field">
            <label class="fav-sort-label">源收藏夹名称</label>
            <textarea class="fav-sort-textarea" name="folderNames" placeholder="每行一个，或使用逗号/分号分隔"></textarea>
            <div class="fav-sort-hint">支持英文逗号、中文逗号、分号、换行分隔。</div>
          </div>
          <div class="fav-sort-field">
            <label class="fav-sort-label">新收藏夹基础名称</label>
            <input class="fav-sort-input" name="baseName" maxlength="10" value="${CONFIG.defaultNewFolderNamePrefix}" />
            <div class="fav-sort-hint">默认不超过 10 字符，最终收藏夹名不超过 20 字符。</div>
          </div>
          <div class="fav-sort-field">
            <label class="fav-sort-label">每个新收藏夹视频上限</label>
            <input class="fav-sort-input" name="targetCap" type="number" min="1" max="${CONFIG.maxFolderSize}" value="${CONFIG.defaultTargetFolderSize}" />
            <div class="fav-sort-hint">可填 800、900 等，达到上限后下一个UP主整体进下个收藏夹。</div>
          </div>
          <div class="fav-sort-actions">
            <button class="fav-sort-btn fav-sort-btn-secondary" data-action="cancel" type="button">取消</button>
            <button class="fav-sort-btn fav-sort-btn-primary" data-action="start" type="button">开始执行</button>
          </div>
          <div class="fav-sort-status" data-role="status">等待开始。</div>
        </div>
      </div>
    `;

    document.body.appendChild(launcher);
    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector('.fav-sort-close');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const startBtn = overlay.querySelector('[data-action="start"]');
    const statusNode = overlay.querySelector('[data-role="status"]');
    const folderNamesField = overlay.querySelector('[name="folderNames"]');
    const baseNameField = overlay.querySelector('[name="baseName"]');
    const targetCapField = overlay.querySelector('[name="targetCap"]');

    const setBusy = (busy) => {
      startBtn.disabled = busy;
      cancelBtn.disabled = busy;
      closeBtn.disabled = busy;
      launcher.disabled = busy;
      startBtn.textContent = busy ? '执行中...' : '开始执行';
    };

    const hide = () => overlay.classList.remove('show');
    const show = () => overlay.classList.add('show');

    launcher.addEventListener('click', show);
    closeBtn.addEventListener('click', hide);
    cancelBtn.addEventListener('click', hide);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hide();
    });

    startBtn.addEventListener('click', async () => {
      const folderNames = parseFolderNames(folderNamesField.value || '');
      const baseName = truncateName((baseNameField.value || '').trim() || CONFIG.defaultNewFolderNamePrefix, 10);
      const targetCap = Number(targetCapField.value || CONFIG.defaultTargetFolderSize);

      if (folderNames.length === 0) {
        statusNode.textContent = '请至少填写一个收藏夹名称。';
        return;
      }
      if (!Number.isInteger(targetCap) || targetCap < 1 || targetCap > CONFIG.maxFolderSize) {
        statusNode.textContent = `视频上限无效，请输入 1-${CONFIG.maxFolderSize} 的整数。`;
        return;
      }

      setBusy(true);
      statusNode.textContent = '任务执行中，请勿关闭页面...';

      try {
        await onStart({ folderNames, newFolderBaseName: baseName, targetFolderSize: targetCap });
        statusNode.textContent = '任务已完成，请查看页面弹窗与控制台日志。';
      } catch (err) {
        statusNode.textContent = `执行失败：${err.message || err}`;
      } finally {
        setBusy(false);
      }
    });
  }

  async function runSortTask({ folderNames, newFolderBaseName, targetFolderSize }) {
    log('开始执行');

    const mid = getMyMid();
    const csrf = getCsrf();

    const allFolders = await withRetry(() => fetchCreatedFolders(mid), '获取收藏夹列表');
    const { selected, missing } = pickFoldersByName(allFolders, folderNames);

    if (missing.length > 0) {
      throw new Error(`以下收藏夹不存在或名称不匹配：${missing.join('、')}`);
    }

    if (selected.length < 1) {
      throw new Error('未匹配到任何收藏夹。');
    }

    log('匹配收藏夹：', selected.map((f) => `${f.title}(${f.id})`).join(', '));

    const collectTasks = selected.map(async (folder) => {
      const { medias, expectedCount } = await withRetry(
        () => fetchFolderResources(folder.id, folder.title),
        `读取收藏夹 ${folder.title}`,
      );
      log(`收藏夹「${folder.title}」读取完成：${medias.length}${Number.isFinite(expectedCount) ? `/${expectedCount}` : ''} 条`);
      return medias.map((media) => ({
        srcMediaId: folder.id,
        srcFolderTitle: folder.title,
        media,
      }));
    });

    const nestedItems = await Promise.all(collectTasks);
    const items = nestedItems.flat();

    if (items.length === 0) {
      throw new Error('所选收藏夹没有可移动的视频。');
    }

    const groups = buildUploaderGroups(items);
    const chunks = buildFolderChunks(groups, targetFolderSize);

    const planSummary = chunks.map((chunk, idx) => {
      const upStart = chunk.groups[0]?.upName || '-';
      const upEnd = chunk.groups[chunk.groups.length - 1]?.upName || '-';
      return `分组${idx + 1}: ${chunk.total}个视频 / ${chunk.groups.length}位UP（${upStart} -> ${upEnd}）`;
    });

    const confirmed = confirm(
      `即将把 ${items.length} 个视频移动到 ${chunks.length} 个新收藏夹。\n` +
      `每个新收藏夹上限：${targetFolderSize}。\n` +
      `涉及 ${selected.length} 个源收藏夹、${groups.length} 位UP主。\n\n` +
      `${planSummary.join('\n')}\n\n继续吗？`,
    );

    if (!confirmed) {
      alert('已取消执行。');
      return;
    }

    let success = 0;
    const failed = [];
    const createdFolders = [];

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const folderName = buildTargetFolderName(newFolderBaseName, chunkIndex, chunks.length);
      const dstMediaId = await withRetry(() => createFolder(folderName, csrf), `创建新收藏夹 ${folderName}`);
      createdFolders.push({ name: folderName, id: dstMediaId, total: chunk.total });
      log(`新收藏夹已创建：${folderName} (${dstMediaId})，计划 ${chunk.total} 个视频`);

      const displayOrderItems = chunk.groups.flatMap((group) => group.items);
      const moveOrderItems = [...displayOrderItems].reverse();

      for (let i = 0; i < moveOrderItems.length; i += 1) {
        const { srcMediaId, srcFolderTitle, media } = moveOrderItems[i];
        const upMid = String(media?.upper?.mid || '0');
        const upName = String(media?.upper?.name || upMid);
        const title = media?.title || `id=${media?.id}`;
        const summary = `分组${chunkIndex + 1}/${chunks.length} ${i + 1}/${moveOrderItems.length} | [${srcFolderTitle}] ${title} | UP=${upName}`;

        try {
          await withRetry(() => moveResource(srcMediaId, dstMediaId, media, csrf), `移动视频 ${summary}`);
          success += 1;
          log(`✔ ${summary}`);
        } catch (err) {
          failed.push({ media, reason: err.message || String(err), folderName });
          log(`✘ ${summary}`, err);
        }

        await sleep(CONFIG.moveDelayMs);
      }
    }

    const folderText = createdFolders.map((f) => `${f.name}(id=${f.id}, ${f.total}条)`).join('；');
    const report = `完成：成功 ${success}/${items.length}，失败 ${failed.length}。新收藏夹：${folderText}`;
    log(report, failed);
    alert(report);
  }

  try {
    createControlPanel(runSortTask);
    log('控件已加载，点击右下角「收藏夹智能整理」开始。');
  } catch (err) {
    console.error('[FavSort] 初始化失败', err);
    alert(`脚本初始化失败：${err.message || err}`);
  }
})();
