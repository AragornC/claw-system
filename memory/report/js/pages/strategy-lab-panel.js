(function(globalObj) {
  function defaultEscapeHtml(valueLike) {
    return String(valueLike == null ? '' : valueLike)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setupStrategyLabPanelRuntime(optionsLike) {
    const options = optionsLike && typeof optionsLike === 'object' ? optionsLike : {};
    const getLatestBacktestResult = typeof options.getLatestBacktestResult === 'function'
      ? options.getLatestBacktestResult
      : function() { return null; };
    const OHLCV_BY_TF = options.ohlcvByTf && typeof options.ohlcvByTf === 'object'
      ? options.ohlcvByTf
      : {};
    const switchView = typeof options.switchView === 'function'
      ? options.switchView
      : function() {};
    const focusKlineByFeatureSample = typeof options.focusKlineByFeatureSample === 'function'
      ? options.focusKlineByFeatureSample
      : function() { return { ok: false }; };
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : defaultEscapeHtml;

        const statusEl = document.getElementById('sl-status');
        const evalStatusEl = document.getElementById('sl-eval-status');
        const featureListEl = document.getElementById('sl-feature-list');
        const versionListEl = document.getElementById('sl-version-list');
        const baseVersionEl = document.getElementById('sl-base-version');
        const evalVersionEl = document.getElementById('sl-eval-version');
        const proposeBtn = document.getElementById('sl-propose-btn');
        const refreshBtn = document.getElementById('sl-refresh-btn');
        const featureQEl = document.getElementById('sl-feature-q');
        const featureMainCategoryEl = document.getElementById('sl-feature-main-category');
        const featureTagEl = document.getElementById('sl-feature-tag');
        const featureSourceEl = document.getElementById('sl-feature-source');
        const featureEnabledEl = document.getElementById('sl-feature-enabled');
        const featureSortByEl = document.getElementById('sl-feature-sort-by');
        const featureSortOrderEl = document.getElementById('sl-feature-sort-order');
        const featurePageSizeEl = document.getElementById('sl-feature-page-size');
        const featurePreviewTfEl = document.getElementById('sl-feature-preview-tf');
        const featurePreviewWindowEl = document.getElementById('sl-feature-preview-window');
        const featurePresetSelectEl = document.getElementById('sl-feature-preset-select');
        const featurePresetNameEl = document.getElementById('sl-feature-preset-name');
        const featurePresetSaveBtn = document.getElementById('sl-feature-preset-save');
        const featurePresetApplyBtn = document.getElementById('sl-feature-preset-apply');
        const featurePresetDeleteBtn = document.getElementById('sl-feature-preset-delete');
        const featurePrevBtn = document.getElementById('sl-feature-prev');
        const featureNextBtn = document.getElementById('sl-feature-next');
        const featurePageInfoEl = document.getElementById('sl-feature-page-info');
        const featureDetailModalEl = document.getElementById('sl-feature-detail-modal');
        const featureDetailTitleEl = document.getElementById('sl-feature-detail-title');
        const featureDetailMetaEl = document.getElementById('sl-feature-detail-meta');
        const featureDetailContentEl = document.getElementById('sl-feature-detail-content');
        const featureDetailCloseBtn = document.getElementById('sl-feature-detail-close');
        const promptEl = document.getElementById('sl-prompt');
        const fillBtn = document.getElementById('sl-fill-latest-btn');
        const evalBtn = document.getElementById('sl-eval-btn');
        const tradesEl = document.getElementById('sl-eval-trades');
        const winRateEl = document.getElementById('sl-eval-winrate');
        const pnlEl = document.getElementById('sl-eval-pnl');
        const ddEl = document.getElementById('sl-eval-dd');
        const sharpeEl = document.getElementById('sl-eval-sharpe');
        const pfEl = document.getElementById('sl-eval-pf');
        const backtestCoreEl = document.getElementById('sl-lab-backtest-core');
        const featurePanelEl = document.getElementById('sl-panel-feature');
        const strategyPanelEl = document.getElementById('sl-panel-strategy');
        const labPanelEl = document.getElementById('sl-panel-lab');
        const tabButtons = Array.from(document.querySelectorAll('[data-sl-tab]'));
        if (!statusEl || !evalStatusEl || !featureListEl || !versionListEl || !baseVersionEl || !evalVersionEl || !proposeBtn || !refreshBtn || !featureQEl || !featureMainCategoryEl || !featureTagEl || !featureSourceEl || !featureEnabledEl || !featureSortByEl || !featureSortOrderEl || !featurePageSizeEl || !featurePreviewTfEl || !featurePreviewWindowEl || !featurePresetSelectEl || !featurePresetNameEl || !featurePresetSaveBtn || !featurePresetApplyBtn || !featurePresetDeleteBtn || !featurePrevBtn || !featureNextBtn || !featurePageInfoEl || !featureDetailModalEl || !featureDetailTitleEl || !featureDetailMetaEl || !featureDetailContentEl || !featureDetailCloseBtn || !promptEl || !fillBtn || !evalBtn || !tradesEl || !winRateEl || !pnlEl || !ddEl || !sharpeEl || !pfEl) return;
        const featureViewState = {
          page: 1,
          pageSize: Number(featurePageSizeEl.value || 40) || 40,
          totalPages: 1,
          lastTotal: 0,
          previewTf: String(featurePreviewTfEl.value || 'auto'),
          previewWindow: Math.max(60, Math.min(360, Number(featurePreviewWindowEl.value || 120) || 120)),
          presets: [],
          featureByKey: {},
        };
        const FEATURE_FILTER_PRESET_KEY = 'thunderclaw.strategy.feature.presets.v1';
        const featureTaxonomyConfig = typeof getStrategyFeatureConfigRuntime === 'function'
          ? getStrategyFeatureConfigRuntime()
          : null;
        let featureModalPrevOverflow = '';

        function switchStrategyLabTab(tabKeyLike) {
          const tabKey = String(tabKeyLike || '').trim() || 'feature';
          closeFeatureDetailModal();
          tabButtons.forEach(function(btn) {
            btn.classList.toggle('active', String(btn.getAttribute('data-sl-tab') || '') === tabKey);
          });
          if (featurePanelEl) featurePanelEl.classList.toggle('active', tabKey === 'feature');
          if (strategyPanelEl) strategyPanelEl.classList.toggle('active', tabKey === 'strategy');
          if (labPanelEl) labPanelEl.classList.toggle('active', tabKey === 'lab');
          if (backtestCoreEl) backtestCoreEl.style.display = tabKey === 'lab' ? '' : 'none';
        }
        function featureKeyOf(featureLike) {
          const feature = featureLike && typeof featureLike === 'object' ? featureLike : {};
          const id = String(feature.featureId || '').trim();
          if (id) return id;
          const name = String(feature.name || '').trim();
          if (name) return name;
          return '';
        }
        function closeFeatureDetailModal() {
          if (featureDetailModalEl.hidden) return;
          featureDetailModalEl.hidden = true;
          featureDetailTitleEl.textContent = '特征详情';
          featureDetailMetaEl.textContent = '';
          featureDetailContentEl.innerHTML = '';
          if (document.body && document.body.getAttribute('data-feature-modal-locked') === '1') {
            document.body.style.overflow = featureModalPrevOverflow;
            document.body.removeAttribute('data-feature-modal-locked');
          }
        }
        function openFeatureDetailModal(rawFeatureLike) {
          const rawFeature = rawFeatureLike && typeof rawFeatureLike === 'object' ? rawFeatureLike : null;
          if (!rawFeature) {
            setStatus(statusEl, '无法打开详情：特征不存在。', 'err');
            return;
          }
          const normalizeFeature = typeof normalizeStrategyFeatureRuntime === 'function'
            ? normalizeStrategyFeatureRuntime
            : null;
          const renderDetail = typeof renderStrategyFeatureDetailModalRuntime === 'function'
            ? renderStrategyFeatureDetailModalRuntime
            : null;
          const feature = normalizeFeature ? normalizeFeature(rawFeature) : rawFeature;
          const title = String(feature?.title || feature?.name || feature?.featureId || '特征详情');
          featureDetailTitleEl.textContent = title;
          featureDetailMetaEl.textContent = '主分类：' + String(feature?.mainCategoryLabel || feature?.mainCategory || '-')
            + ' · 输出：' + String(feature?.outputTypeLabel || feature?.outputType || '-')
            + ' · 更新时间：' + String(feature?.updatedAt || '-');
          if (renderDetail) {
            featureDetailContentEl.innerHTML = renderDetail(rawFeature, {
              previewTf: String(featureViewState.previewTf || featurePreviewTfEl.value || 'auto'),
              previewWindow: Math.max(160, Math.min(360, Number(featureViewState.previewWindow || featurePreviewWindowEl.value || 180) || 180)),
              ohlcvByTf: OHLCV_BY_TF || {},
              originTrailLimit: 8,
              detailMode: true,
            });
          } else {
            featureDetailContentEl.innerHTML = '<div class="feature-detail-card"><div class="meta">详情渲染模块未加载。</div></div>';
          }
          const firstTocBtn = featureDetailContentEl.querySelector('.feature-detail-toc-btn');
          if (firstTocBtn && firstTocBtn.classList) firstTocBtn.classList.add('active');
          featureDetailModalEl.hidden = false;
          featureDetailContentEl.scrollTop = 0;
          if (document.body) {
            featureModalPrevOverflow = String(document.body.style.overflow || '');
            document.body.style.overflow = 'hidden';
            document.body.setAttribute('data-feature-modal-locked', '1');
          }
        }
        function openFeatureDetailByKey(keyLike) {
          const key = String(keyLike || '').trim();
          if (!key) {
            setStatus(statusEl, '无法打开详情：特征ID缺失。', 'err');
            return;
          }
          const bucket = featureViewState.featureByKey && typeof featureViewState.featureByKey === 'object'
            ? featureViewState.featureByKey
            : {};
          const feature = bucket[key] || null;
          if (!feature) {
            setStatus(statusEl, '无法打开详情：特征缓存不存在，请刷新后重试。', 'err');
            return;
          }
          openFeatureDetailModal(feature);
        }
        tabButtons.forEach(function(btn) {
          btn.addEventListener('click', function() {
            switchStrategyLabTab(btn.getAttribute('data-sl-tab'));
          });
        });
        featureDetailCloseBtn.addEventListener('click', function() {
          closeFeatureDetailModal();
        });
        featureDetailModalEl.addEventListener('click', function(ev) {
          const closer = ev.target && ev.target.closest ? ev.target.closest('[data-feature-detail-close]') : null;
          if (closer) closeFeatureDetailModal();
        });
        document.addEventListener('keydown', function(ev) {
          if (String(ev?.key || '') === 'Escape' && !featureDetailModalEl.hidden) {
            closeFeatureDetailModal();
          }
        });
        switchStrategyLabTab('feature');
        featureViewState.presets = loadFeaturePresets();
        renderFeaturePresetOptions('');
        featureViewState.previewTf = String(featurePreviewTfEl.value || featureViewState.previewTf || 'auto');
        featureViewState.previewWindow = Math.max(60, Math.min(360, Number(featurePreviewWindowEl.value || featureViewState.previewWindow || 120) || 120));

        function setStatus(el, text, kind) {
          if (!el) return;
          el.textContent = String(text || '');
          el.classList.remove('ok', 'err');
          if (kind === 'ok') el.classList.add('ok');
          if (kind === 'err') el.classList.add('err');
        }
        function safeLocalReadJson(keyLike, fallbackLike) {
          const key = String(keyLike || '').trim();
          if (!key) return fallbackLike;
          try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallbackLike;
            const parsed = JSON.parse(raw);
            return parsed == null ? fallbackLike : parsed;
          } catch {
            return fallbackLike;
          }
        }
        function safeLocalWriteJson(keyLike, valueLike) {
          const key = String(keyLike || '').trim();
          if (!key) return false;
          try {
            localStorage.setItem(key, JSON.stringify(valueLike));
            return true;
          } catch {
            return false;
          }
        }
        function normalizePresetName(nameLike) {
          const n = String(nameLike || '').trim().replace(/\s+/g, ' ');
          return n.slice(0, 28);
        }
        function getSelectValueSafe(selectElLike, fallbackLike) {
          const el = selectElLike;
          if (!el) return String(fallbackLike || '');
          return String(el.value || fallbackLike || '');
        }
        function setSelectValueSafe(selectElLike, valueLike) {
          const el = selectElLike;
          if (!el) return;
          const value = String(valueLike || '');
          const options = Array.from(el.options || []).map(function(op) { return String(op?.value || ''); });
          el.value = options.includes(value) ? value : '';
        }
        function collectFeatureFilterState() {
          return {
            q: String(featureQEl.value || '').trim(),
            mainCategory: getSelectValueSafe(featureMainCategoryEl, ''),
            tag: getSelectValueSafe(featureTagEl, ''),
            source: getSelectValueSafe(featureSourceEl, ''),
            enabled: getSelectValueSafe(featureEnabledEl, ''),
            sortBy: getSelectValueSafe(featureSortByEl, 'updatedAt') || 'updatedAt',
            sortOrder: getSelectValueSafe(featureSortOrderEl, 'desc') || 'desc',
            pageSize: Math.max(10, Math.min(120, Number(featurePageSizeEl.value || featureViewState.pageSize || 40) || 40)),
            previewTf: getSelectValueSafe(featurePreviewTfEl, featureViewState.previewTf || 'auto') || 'auto',
            previewWindow: Math.max(60, Math.min(360, Number(featurePreviewWindowEl.value || featureViewState.previewWindow || 120) || 120)),
          };
        }
        function applyFeatureFilterState(stateLike) {
          const state = stateLike && typeof stateLike === 'object' ? stateLike : {};
          featureQEl.value = String(state.q || '');
          setSelectValueSafe(featureMainCategoryEl, state.mainCategory || '');
          setSelectValueSafe(featureTagEl, state.tag || '');
          setSelectValueSafe(featureSourceEl, state.source || '');
          setSelectValueSafe(featureEnabledEl, state.enabled || '');
          setSelectValueSafe(featureSortByEl, state.sortBy || 'updatedAt');
          setSelectValueSafe(featureSortOrderEl, state.sortOrder || 'desc');
          setSelectValueSafe(featurePageSizeEl, String(state.pageSize || featureViewState.pageSize || 40));
          setSelectValueSafe(featurePreviewTfEl, state.previewTf || featureViewState.previewTf || 'auto');
          setSelectValueSafe(featurePreviewWindowEl, String(state.previewWindow || featureViewState.previewWindow || 120));
          featureViewState.pageSize = Math.max(10, Math.min(120, Number(featurePageSizeEl.value || featureViewState.pageSize || 40) || 40));
          featureViewState.previewTf = String(featurePreviewTfEl.value || featureViewState.previewTf || 'auto');
          featureViewState.previewWindow = Math.max(60, Math.min(360, Number(featurePreviewWindowEl.value || featureViewState.previewWindow || 120) || 120));
        }
        function loadFeaturePresets() {
          const rows = safeLocalReadJson(FEATURE_FILTER_PRESET_KEY, []);
          if (!Array.isArray(rows)) return [];
          return rows
            .map(function(item) {
              const row = item && typeof item === 'object' ? item : {};
              const id = String(row.id || '').trim();
              const name = normalizePresetName(row.name || '');
              const filters = row.filters && typeof row.filters === 'object' ? row.filters : {};
              if (!id || !name) return null;
              return {
                id: id,
                name: name,
                filters: filters,
                updatedAt: String(row.updatedAt || ''),
              };
            })
            .filter(Boolean)
            .slice(-20);
        }
        function saveFeaturePresets(rowsLike) {
          const rows = Array.isArray(rowsLike) ? rowsLike : [];
          featureViewState.presets = rows.slice(-20);
          safeLocalWriteJson(FEATURE_FILTER_PRESET_KEY, featureViewState.presets);
        }
        function renderFeaturePresetOptions(selectedIdLike) {
          const selectedId = String(selectedIdLike || featurePresetSelectEl.value || '').trim();
          const options = ['<option value="">筛选预设（未选择）</option>']
            .concat((featureViewState.presets || []).map(function(item) {
              const p = item && typeof item === 'object' ? item : {};
              const id = String(p.id || '');
              const label = String(p.name || id || '');
              return '<option value="' + escapeHtml(id) + '">' + escapeHtml(label) + '</option>';
            }));
          featurePresetSelectEl.innerHTML = options.join('');
          setSelectValueSafe(featurePresetSelectEl, selectedId);
        }
        function saveCurrentFeaturePreset() {
          const name = normalizePresetName(featurePresetNameEl.value || '');
          if (!name) {
            setStatus(statusEl, '请先输入预设名称。', 'err');
            return;
          }
          const current = collectFeatureFilterState();
          const selectedId = String(featurePresetSelectEl.value || '').trim();
          const rows = Array.isArray(featureViewState.presets) ? featureViewState.presets.slice() : [];
          const existingIdx = selectedId ? rows.findIndex(function(item) { return String(item?.id || '') === selectedId; }) : -1;
          if (existingIdx >= 0) {
            rows[existingIdx] = {
              ...rows[existingIdx],
              name: name,
              filters: current,
              updatedAt: new Date().toISOString(),
            };
            saveFeaturePresets(rows);
            renderFeaturePresetOptions(rows[existingIdx].id);
            setStatus(statusEl, '已更新筛选预设：' + name, 'ok');
            return;
          }
          const id = 'fp_' + String(Date.now()) + '_' + String(Math.floor(Math.random() * 9999));
          rows.push({
            id: id,
            name: name,
            filters: current,
            updatedAt: new Date().toISOString(),
          });
          saveFeaturePresets(rows);
          renderFeaturePresetOptions(id);
          setStatus(statusEl, '已保存筛选预设：' + name, 'ok');
        }
        function applySelectedFeaturePreset() {
          const selectedId = String(featurePresetSelectEl.value || '').trim();
          if (!selectedId) {
            setStatus(statusEl, '请先选择一个预设。', 'err');
            return;
          }
          const preset = (featureViewState.presets || []).find(function(item) { return String(item?.id || '') === selectedId; }) || null;
          if (!preset) {
            setStatus(statusEl, '预设不存在，可能已过期。', 'err');
            return;
          }
          applyFeatureFilterState(preset.filters || {});
          featureViewState.page = 1;
          void reloadFeaturesOnly();
          setStatus(statusEl, '已应用预设：' + String(preset.name || ''), 'ok');
        }
        function deleteSelectedFeaturePreset() {
          const selectedId = String(featurePresetSelectEl.value || '').trim();
          if (!selectedId) {
            setStatus(statusEl, '请先选择要删除的预设。', 'err');
            return;
          }
          const rows = (featureViewState.presets || []).filter(function(item) { return String(item?.id || '') !== selectedId; });
          saveFeaturePresets(rows);
          renderFeaturePresetOptions('');
          setStatus(statusEl, '已删除筛选预设。', 'ok');
        }
        function jumpToChatEvent(eventIdLike) {
          const eventId = Number(eventIdLike);
          if (!Number.isFinite(eventId) || eventId <= 0) {
            setStatus(statusEl, '无法跳转：消息ID无效。', 'err');
            return;
          }
          try { switchView('dashboard'); } catch (_) {}
          window.setTimeout(function() {
            const chatBox = document.getElementById('ai-chat-box');
            if (!chatBox) {
              setStatus(statusEl, '找不到对话面板，无法跳转。', 'err');
              return;
            }
            const row = chatBox.querySelector('.ai-msg-row[data-event-id="' + String(eventId) + '"]');
            if (!row) {
              setStatus(statusEl, '未在当前对话缓存中找到消息#' + String(eventId) + '，请稍后重试。', 'err');
              return;
            }
            row.classList.add('jump-highlight');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            window.setTimeout(function() {
              row.classList.remove('jump-highlight');
            }, 2200);
            setStatus(statusEl, '已跳转并高亮消息 #' + String(eventId), 'ok');
          }, 90);
        }
        async function readJson(resp) {
          const payload = await resp.json().catch(function() { return null; });
          if (!resp.ok || !payload || payload.ok !== true) {
            throw new Error(String(payload?.error || ('HTTP ' + resp.status)));
          }
          return payload;
        }
        // 特征详情与分类可视化已拆分到 ./js/modules/strategy-feature-runtime.js
        function syncSelectOptions(selectEl, valuesLike, defaultText, keepValue, labelFnLike) {
          const el = selectEl;
          if (!el) return;
          const values = Array.isArray(valuesLike) ? valuesLike.map(function(v) { return String(v || '').trim(); }).filter(Boolean) : [];
          const selected = String(keepValue != null ? keepValue : el.value || '');
          const labelFn = typeof labelFnLike === 'function' ? labelFnLike : null;
          const options = ['<option value="">' + escapeHtml(defaultText || '全部') + '</option>']
            .concat(values.map(function(v) {
              const labelRaw = labelFn ? String(labelFn(v) || v) : v;
              return '<option value="' + escapeHtml(v) + '">' + escapeHtml(labelRaw) + '</option>';
            }));
          el.innerHTML = options.join('');
          if (selected && values.includes(selected)) el.value = selected;
          else if (!selected) el.value = '';
        }
        if (featureTaxonomyConfig && featureTaxonomyConfig.mainCategories) {
          syncSelectOptions(
            featureMainCategoryEl,
            Object.keys(featureTaxonomyConfig.mainCategories || {}),
            '全部主分类',
            '',
            function(v) {
              const row = featureTaxonomyConfig.mainCategories && featureTaxonomyConfig.mainCategories[v];
              return String(row?.label || v || '');
            },
          );
        }
        if (featureTaxonomyConfig && featureTaxonomyConfig.tags) {
          syncSelectOptions(
            featureTagEl,
            Object.keys(featureTaxonomyConfig.tags || {}),
            '全部功能标签',
            '',
            function(v) {
              const row = featureTaxonomyConfig.tags && featureTaxonomyConfig.tags[v];
              return String(row?.label || v || '');
            },
          );
        }
        function renderFeaturePagination(payloadLike) {
          const payload = payloadLike && typeof payloadLike === 'object' ? payloadLike : {};
          featureViewState.page = Math.max(1, Number(payload.page || featureViewState.page || 1));
          featureViewState.pageSize = Math.max(10, Math.min(120, Number(payload.pageSize || featureViewState.pageSize || 40)));
          featureViewState.totalPages = Math.max(1, Number(payload.totalPages || 1));
          featureViewState.lastTotal = Math.max(0, Number(payload.total || 0));
          setSelectValueSafe(featurePageSizeEl, String(featureViewState.pageSize));
          featurePageInfoEl.textContent = '第 ' + String(featureViewState.page) + '/' + String(featureViewState.totalPages) + ' 页 · 共 ' + String(featureViewState.lastTotal) + ' 个';
          featurePrevBtn.disabled = featureViewState.page <= 1;
          featureNextBtn.disabled = featureViewState.page >= featureViewState.totalPages;
        }
        async function fetchFeatures() {
          const q = String(featureQEl.value || '').trim();
          const mainCategory = String(featureMainCategoryEl.value || '').trim();
          const tag = String(featureTagEl.value || '').trim();
          const source = String(featureSourceEl.value || '').trim();
          const enabled = String(featureEnabledEl.value || '').trim();
          const sortBy = String(featureSortByEl.value || 'updatedAt').trim() || 'updatedAt';
          const sortOrder = String(featureSortOrderEl.value || 'desc').trim() || 'desc';
          const pageSize = Math.max(10, Math.min(120, Number(featurePageSizeEl.value || featureViewState.pageSize || 40) || 40));
          featureViewState.pageSize = pageSize;
          const url = '/api/strategy/features'
            + '?q=' + encodeURIComponent(q)
            + '&mainCategory=' + encodeURIComponent(mainCategory)
            + '&tag=' + encodeURIComponent(tag)
            + '&source=' + encodeURIComponent(source)
            + '&enabled=' + encodeURIComponent(enabled)
            + '&sortBy=' + encodeURIComponent(sortBy)
            + '&sortOrder=' + encodeURIComponent(sortOrder)
            + '&page=' + encodeURIComponent(String(featureViewState.page))
            + '&pageSize=' + encodeURIComponent(String(pageSize));
          const resp = await fetch(url, { cache: 'no-store' });
          return readJson(resp);
        }
        async function fetchVersions() {
          const resp = await fetch('/api/strategy/versions?limit=80', { cache: 'no-store' });
          return readJson(resp);
        }
        function renderFeatures(list, payloadLike) {
          const rows = Array.isArray(list) ? list : [];
          const payload = payloadLike && typeof payloadLike === 'object' ? payloadLike : {};
          featureViewState.lastFeaturePayload = payload;
          const facets = payload.facets && typeof payload.facets === 'object' ? payload.facets : {};
          const taxonomy = facets.taxonomy && typeof facets.taxonomy === 'object'
            ? facets.taxonomy
            : (typeof getStrategyFeatureConfigRuntime === 'function' ? getStrategyFeatureConfigRuntime() : null);
          const categoryLabeler = function(keyLike) {
            const key = String(keyLike || '').trim().toLowerCase();
            const row = taxonomy && taxonomy.mainCategories && taxonomy.mainCategories[key];
            if (row && row.label) return String(row.label);
            if (typeof getStrategyFeatureLabelRuntime === 'function') {
              return String(getStrategyFeatureLabelRuntime('category', key) || key);
            }
            return key;
          };
          const tagLabeler = function(keyLike) {
            const key = String(keyLike || '').trim().toLowerCase();
            const row = taxonomy && taxonomy.tags && taxonomy.tags[key];
            if (row && row.label) return String(row.label);
            if (typeof getStrategyFeatureLabelRuntime === 'function') {
              return String(getStrategyFeatureLabelRuntime('tag', key) || key);
            }
            return key;
          };
          syncSelectOptions(featureSourceEl, Array.isArray(facets.sources) ? facets.sources : [], '全部来源', featureSourceEl.value);
          syncSelectOptions(featureMainCategoryEl, Array.isArray(facets.mainCategories) ? facets.mainCategories : [], '全部主分类', featureMainCategoryEl.value, categoryLabeler);
          syncSelectOptions(featureTagEl, Array.isArray(facets.tags) ? facets.tags : [], '全部功能标签', featureTagEl.value, tagLabeler);
          renderFeaturePagination(payload);
          if (!rows.length) {
            featureViewState.featureByKey = {};
            featureListEl.innerHTML = '<div class="strategy-feature-item"><div class="meta">暂无特征</div></div>';
            return;
          }
          const renderCard = typeof renderStrategyFeatureCardRuntime === 'function'
            ? renderStrategyFeatureCardRuntime
            : null;
          const renderContext = {
            previewTf: String(featureViewState.previewTf || featurePreviewTfEl.value || 'auto'),
            previewWindow: Math.max(60, Math.min(360, Number(featureViewState.previewWindow || featurePreviewWindowEl.value || 120) || 120)),
            ohlcvByTf: OHLCV_BY_TF || {},
            originTrailLimit: 4,
          };
          const featureMap = {};
          rows.forEach(function(item) {
            const key = featureKeyOf(item);
            if (!key) return;
            featureMap[key] = item;
          });
          featureViewState.featureByKey = featureMap;
          featureListEl.innerHTML = rows.map(function(item) {
            const itemKey = featureKeyOf(item);
            if (renderCard) {
              return renderCard(item, { ...renderContext, itemKey: itemKey });
            }
            const fallbackName = String(item?.name || item?.featureId || '-');
            return '<div class="strategy-feature-item"><div class="name">' + escapeHtml(fallbackName) + '</div><div class="meta">特征渲染模块未加载。</div></div>';
          }).join('');
        }
        function renderVersionSelectors(list) {
          const rows = Array.isArray(list) ? list : [];
          const options = rows.map(function(v) {
            const id = String(v?.versionId || '');
            const title = String(v?.title || id || '-');
            const score = Number.isFinite(Number(v?.score)) ? (' · score=' + Number(v.score).toFixed(4)) : '';
            return '<option value="' + escapeHtml(id) + '">' + escapeHtml(title + score) + '</option>';
          }).join('');
          baseVersionEl.innerHTML = options;
          evalVersionEl.innerHTML = options;
        }
        function renderVersions(list) {
          const rows = Array.isArray(list) ? list : [];
          if (!rows.length) {
            versionListEl.innerHTML = '<div class="strategy-version-item"><div class="meta">暂无版本</div></div>';
            return;
          }
          versionListEl.innerHTML = rows.slice(0, 80).map(function(v) {
            const id = String(v?.versionId || '-');
            const title = String(v?.title || id);
            const status = String(v?.status || 'draft');
            const parent = String(v?.parentVersionId || '-');
            const score = Number.isFinite(Number(v?.score)) ? Number(v.score).toFixed(4) : 'NA';
            const summary = String(v?.evalSummary || '');
            return '<div class="strategy-version-item">'
              + '<div class="name">' + escapeHtml(title) + '</div>'
              + '<div class="meta">id=' + escapeHtml(id) + ' · status=' + escapeHtml(status) + ' · parent=' + escapeHtml(parent) + '</div>'
              + '<div class="score">Score: ' + escapeHtml(score) + '</div>'
              + (summary ? ('<div class="meta">' + escapeHtml(summary) + '</div>') : '')
              + '</div>';
          }).join('');
        }
        async function reloadAll() {
          closeFeatureDetailModal();
          setStatus(statusEl, '加载实验室数据中...', '');
          try {
            const featuresPayload = await fetchFeatures();
            renderFeatures(featuresPayload.features, featuresPayload);
            const versionsPayload = await fetchVersions();
            renderVersions(versionsPayload.versions);
            renderVersionSelectors(versionsPayload.versions);
            setStatus(statusEl, '实验室已更新：特征 ' + String(featuresPayload.total || 0) + ' 个，版本 ' + String(versionsPayload.total || 0) + ' 个。', 'ok');
          } catch (err) {
            setStatus(statusEl, '加载失败：' + String(err?.message || err), 'err');
          }
        }
        async function reloadFeaturesOnly() {
          try {
            const payload = await fetchFeatures();
            renderFeatures(payload.features, payload);
          } catch (err) {
            setStatus(statusEl, '特征刷新失败：' + String(err?.message || err), 'err');
          }
        }
        function rerenderFeatureListFromCache() {
          const payload = featureViewState.lastFeaturePayload && typeof featureViewState.lastFeaturePayload === 'object'
            ? featureViewState.lastFeaturePayload
            : null;
          if (!payload || !Array.isArray(payload.features)) {
            void reloadFeaturesOnly();
            return;
          }
          renderFeatures(payload.features, payload);
        }
        function resetFeaturePageAndReload() {
          closeFeatureDetailModal();
          featureViewState.page = 1;
          void reloadFeaturesOnly();
        }

        proposeBtn.addEventListener('click', function() {
          const message = String(promptEl.value || '').trim();
          if (!message) {
            setStatus(statusEl, '请先输入优化目标。', 'err');
            return;
          }
          const baseVersionId = String(baseVersionEl.value || '').trim();
          proposeBtn.disabled = true;
          setStatus(statusEl, '正在生成候选版本...', '');
          void fetch('/api/strategy/versions/propose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message, baseVersionId: baseVersionId || null }),
          })
            .then(readJson)
            .then(function(payload) {
              const count = Array.isArray(payload.proposals) ? payload.proposals.length : 0;
              setStatus(statusEl, '已生成 ' + String(count) + ' 个候选版本。', 'ok');
              return reloadAll();
            })
            .catch(function(err) {
              setStatus(statusEl, '生成失败：' + String(err?.message || err), 'err');
            })
            .finally(function() {
              proposeBtn.disabled = false;
            });
        });

        refreshBtn.addEventListener('click', function() {
          void reloadAll();
        });
        let featureSearchTimer = null;
        featureQEl.addEventListener('input', function() {
          if (featureSearchTimer) clearTimeout(featureSearchTimer);
          featureSearchTimer = window.setTimeout(function() {
            resetFeaturePageAndReload();
          }, 260);
        });
        featureMainCategoryEl.addEventListener('change', resetFeaturePageAndReload);
        featureTagEl.addEventListener('change', resetFeaturePageAndReload);
        featureSourceEl.addEventListener('change', resetFeaturePageAndReload);
        featureEnabledEl.addEventListener('change', resetFeaturePageAndReload);
        featureSortByEl.addEventListener('change', resetFeaturePageAndReload);
        featureSortOrderEl.addEventListener('change', resetFeaturePageAndReload);
        featurePageSizeEl.addEventListener('change', function() {
          featureViewState.pageSize = Math.max(10, Math.min(120, Number(featurePageSizeEl.value || 40) || 40));
          resetFeaturePageAndReload();
        });
        featurePreviewTfEl.addEventListener('change', function() {
          featureViewState.previewTf = String(featurePreviewTfEl.value || 'auto');
          rerenderFeatureListFromCache();
        });
        featurePreviewWindowEl.addEventListener('change', function() {
          featureViewState.previewWindow = Math.max(60, Math.min(360, Number(featurePreviewWindowEl.value || 120) || 120));
          rerenderFeatureListFromCache();
        });
        featurePrevBtn.addEventListener('click', function() {
          if (featureViewState.page <= 1) return;
          featureViewState.page -= 1;
          void reloadFeaturesOnly();
        });
        featureNextBtn.addEventListener('click', function() {
          if (featureViewState.page >= featureViewState.totalPages) return;
          featureViewState.page += 1;
          void reloadFeaturesOnly();
        });
        featurePresetSaveBtn.addEventListener('click', function() {
          saveCurrentFeaturePreset();
        });
        featurePresetApplyBtn.addEventListener('click', function() {
          applySelectedFeaturePreset();
        });
        featurePresetDeleteBtn.addEventListener('click', function() {
          deleteSelectedFeaturePreset();
        });
        featurePresetSelectEl.addEventListener('change', function() {
          const selectedId = String(featurePresetSelectEl.value || '').trim();
          const preset = (featureViewState.presets || []).find(function(item) { return String(item?.id || '') === selectedId; }) || null;
          if (preset) {
            featurePresetNameEl.value = String(preset.name || '');
          } else {
            featurePresetNameEl.value = '';
          }
        });
        function handleFeatureSampleAndJumpClick(ev) {
          const btn = ev.target && ev.target.closest ? ev.target.closest('[data-feature-jump-event]') : null;
          if (btn) {
            ev.preventDefault();
            const eventId = Number(btn.getAttribute('data-feature-jump-event') || '');
            closeFeatureDetailModal();
            jumpToChatEvent(eventId);
            return true;
          }
          const sampleNode = ev.target && ev.target.closest
            ? ev.target.closest('[data-feature-bar-time]')
            : null;
          if (!sampleNode) return false;
          ev.preventDefault();
          const sampleTime = Number(sampleNode.getAttribute('data-feature-bar-time') || '');
          const sampleTf = String(sampleNode.getAttribute('data-feature-tf') || featureViewState.previewTf || 'auto');
          const sampleValue = Number(sampleNode.getAttribute('data-feature-value') || '');
          const sampleLabel = String(sampleNode.getAttribute('data-feature-label') || '');
          closeFeatureDetailModal();
          const focused = focusKlineByFeatureSample({
            timeSec: sampleTime,
            tf: sampleTf,
            value: sampleValue,
            label: sampleLabel,
          });
          if (focused?.ok) {
            const text = '已定位到 K 线：TF=' + String(focused.tf || '-') + '，bar#' + String(Number(focused.barIndex || 0) + 1);
            setStatus(statusEl, text, 'ok');
          } else {
            setStatus(statusEl, '定位失败：当前周期未找到对应K线。', 'err');
          }
          return true;
        }
        featureListEl.addEventListener('click', function(ev) {
          const detailBtn = ev.target && ev.target.closest
            ? ev.target.closest('[data-feature-detail-key]')
            : null;
          if (detailBtn) {
            ev.preventDefault();
            openFeatureDetailByKey(detailBtn.getAttribute('data-feature-detail-key') || '');
            return;
          }
          handleFeatureSampleAndJumpClick(ev);
        });
        featureDetailContentEl.addEventListener('click', function(ev) {
          const tocBtn = ev.target && ev.target.closest
            ? ev.target.closest('[data-feature-toc-target]')
            : null;
          if (tocBtn) {
            ev.preventDefault();
            const targetId = String(tocBtn.getAttribute('data-feature-toc-target') || '').trim();
            if (targetId) {
              const targetEl = featureDetailContentEl.querySelector('#' + targetId);
              if (targetEl) {
                featureDetailContentEl.querySelectorAll('.feature-detail-toc-btn.active').forEach(function(btn) {
                  btn.classList.remove('active');
                });
                tocBtn.classList.add('active');
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }
            return;
          }
          handleFeatureSampleAndJumpClick(ev);
        });

        fillBtn.addEventListener('click', function() {
          const latest = typeof getLatestBacktestResult === 'function' ? getLatestBacktestResult() : null;
          if (!latest || typeof latest !== 'object') {
            setStatus(evalStatusEl, '暂无可填充的回验结果，请先跑一次回验。', 'err');
            return;
          }
          tradesEl.value = String(Number(latest.tradeCount || latest.trades || 0) || 0);
          winRateEl.value = String(Number(latest.winRate || 0) || 0);
          pnlEl.value = String(Number(latest.netPnlPct || latest.totalPnlPct || 0) || 0);
          ddEl.value = String(Number(latest.maxDrawdownPct || 0) || 0);
          sharpeEl.value = '';
          pfEl.value = '';
          setStatus(evalStatusEl, '已填充最新回验结果。', 'ok');
        });

        evalBtn.addEventListener('click', function() {
          const versionId = String(evalVersionEl.value || '').trim();
          if (!versionId) {
            setStatus(evalStatusEl, '请选择要评估的版本。', 'err');
            return;
          }
          const metrics = {
            tradeCount: Number(tradesEl.value || 0),
            winRate: Number(winRateEl.value || 0),
            netPnlPct: Number(pnlEl.value || 0),
            maxDrawdownPct: Number(ddEl.value || 0),
            sharpe: Number(sharpeEl.value || 0),
            profitFactor: Number(pfEl.value || 0),
          };
          evalBtn.disabled = true;
          setStatus(evalStatusEl, '正在写入评估...', '');
          void fetch('/api/strategy/versions/evaluate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ versionId: versionId, metrics: metrics }),
          })
            .then(readJson)
            .then(function(payload) {
              const score = Number(payload?.report?.score);
              const scoreText = Number.isFinite(score) ? score.toFixed(4) : 'NA';
              setStatus(evalStatusEl, '评估完成，score=' + scoreText, 'ok');
              return reloadAll();
            })
            .catch(function(err) {
              setStatus(evalStatusEl, '评估失败：' + String(err?.message || err), 'err');
            })
            .finally(function() {
              evalBtn.disabled = false;
            });
        });

        window.addEventListener('thunderclaw:strategy-updated', function(ev) {
          const detail = ev && ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
          const hint = String(detail.reply || detail.message || '已从对话同步新的特征/策略候选。').trim();
          setStatus(statusEl, hint, 'ok');
          void reloadAll();
        });

        void reloadAll();
      
  }

  globalObj.setupStrategyLabPanelRuntime = setupStrategyLabPanelRuntime;
})(typeof window !== 'undefined' ? window : this);
