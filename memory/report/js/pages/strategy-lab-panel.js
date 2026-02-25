(function(globalObj) {
  function setupStrategyLabPanelRuntime(optionsLike) {
    const options = optionsLike && typeof optionsLike === 'object' ? optionsLike : {};
    const runtimeUtils = globalObj.reportRuntimeUtils && typeof globalObj.reportRuntimeUtils === 'object'
      ? globalObj.reportRuntimeUtils
      : {};
    const localJsonState = globalObj.reportLocalJsonState && typeof globalObj.reportLocalJsonState === 'object'
      ? globalObj.reportLocalJsonState
      : {};
    const apiRuntime = globalObj.reportApiRuntime && typeof globalObj.reportApiRuntime === 'object'
      ? globalObj.reportApiRuntime
      : {};
    const constants = globalObj.strategyLabConstants && typeof globalObj.strategyLabConstants === 'object'
      ? globalObj.strategyLabConstants
      : {};
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
      : (runtimeUtils.escapeHtml || function(valueLike) { return String(valueLike == null ? '' : valueLike); });
    const getSelectValueSafe = runtimeUtils.getSelectValueSafe || function(selectElLike, fallbackLike) { return String(selectElLike?.value || fallbackLike || ''); };
    const setSelectValueSafe = runtimeUtils.setSelectValueSafe || function(selectElLike, valueLike) { if (selectElLike) selectElLike.value = String(valueLike || ''); };
    const normalizePresetName = runtimeUtils.normalizePresetName || function(nameLike) { return String(nameLike || '').trim().slice(0, 28); };
    const syncSelectOptions = runtimeUtils.syncSelectOptions || function() {};
    const readLocalJson = localJsonState.readJson || function(_keyLike, fallbackLike) { return fallbackLike; };
    const writeLocalJson = localJsonState.writeJson || function() { return false; };
    const readJsonResponse = apiRuntime.readJsonResponse || (async function(resp) { return resp.json(); });
    const fetchStrategyFeatures = typeof apiRuntime.fetchStrategyFeatures === 'function'
      ? apiRuntime.fetchStrategyFeatures
      : null;
    const fetchStrategyVersions = typeof apiRuntime.fetchStrategyVersions === 'function'
      ? apiRuntime.fetchStrategyVersions
      : null;
    const fetchStrategyEntities = typeof apiRuntime.fetchStrategyEntities === 'function'
      ? apiRuntime.fetchStrategyEntities
      : null;
    const fetchStrategyEntityDetail = typeof apiRuntime.fetchStrategyEntityDetail === 'function'
      ? apiRuntime.fetchStrategyEntityDetail
      : null;
    const fetchStrategyEntityAudits = typeof apiRuntime.fetchStrategyEntityAudits === 'function'
      ? apiRuntime.fetchStrategyEntityAudits
      : null;
    const postStrategyDraftSave = typeof apiRuntime.postStrategyDraftSave === 'function'
      ? apiRuntime.postStrategyDraftSave
      : null;
    const postStrategyPublish = typeof apiRuntime.postStrategyPublish === 'function'
      ? apiRuntime.postStrategyPublish
      : null;
    const postStrategyStatus = typeof apiRuntime.postStrategyStatus === 'function'
      ? apiRuntime.postStrategyStatus
      : null;

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
        const strategyOpsQEl = document.getElementById('sl-ops-q');
        const strategyOpsStatusEl = document.getElementById('sl-ops-status');
        const strategyOpsSortByEl = document.getElementById('sl-ops-sort-by');
        const strategyOpsSortOrderEl = document.getElementById('sl-ops-sort-order');
        const strategyOpsPageSizeEl = document.getElementById('sl-ops-page-size');
        const strategyOpsListEl = document.getElementById('sl-ops-list');
        const strategyOpsPageInfoEl = document.getElementById('sl-ops-page-info');
        const strategyOpsPrevBtn = document.getElementById('sl-ops-prev');
        const strategyOpsNextBtn = document.getElementById('sl-ops-next');
        const strategyOpsRefreshBtn = document.getElementById('sl-ops-refresh');
        const strategyOpsNewDraftBtn = document.getElementById('sl-ops-new-draft');
        const strategyOpsStatusTextEl = document.getElementById('sl-ops-status-text');
        const strategyDetailModalEl = document.getElementById('sl-strategy-detail-modal');
        const strategyDetailTitleEl = document.getElementById('sl-strategy-detail-title');
        const strategyDetailMetaEl = document.getElementById('sl-strategy-detail-meta');
        const strategyDetailBodyEl = document.getElementById('sl-strategy-detail-body');
        const strategyDetailCloseBtn = document.getElementById('sl-strategy-detail-close');
        const strategyDetailStatusEl = document.getElementById('sl-strategy-detail-status');
        const strategyDetailSaveBtn = document.getElementById('sl-strategy-detail-save');
        const strategyDetailPublishBtn = document.getElementById('sl-strategy-detail-publish');
        const strategyDetailStartPaperBtn = document.getElementById('sl-strategy-detail-start-paper');
        const strategyDetailStartLiveBtn = document.getElementById('sl-strategy-detail-start-live');
        const strategyDetailPauseBtn = document.getElementById('sl-strategy-detail-pause');
        const strategyDetailRiskPauseBtn = document.getElementById('sl-strategy-detail-risk-pause');
        const strategyDetailTradeFilterEl = document.getElementById('sl-strategy-trade-filter');
        const strategyDetailPlayToggleBtn = document.getElementById('sl-strategy-play-toggle');
        const strategyDetailPlayResetBtn = document.getElementById('sl-strategy-play-reset');
        const strategyDetailPlaySpeedEl = document.getElementById('sl-strategy-play-speed');
        const strategyDetailRangeCustomEl = document.getElementById('sl-strategy-range-custom');
        const strategyDetailRangeApplyBtn = document.getElementById('sl-strategy-range-apply');
        const strategyDetailRangeBtns = Array.from(document.querySelectorAll('[data-sl-range]'));
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
        const strategyOpsState = {
          page: 1,
          pageSize: Math.max(5, Math.min(100, Number(strategyOpsPageSizeEl?.value || 20) || 20)),
          totalPages: 1,
          total: 0,
          q: '',
          status: '',
          sortBy: 'updatedAt',
          sortOrder: 'desc',
          rows: [],
          selectedStrategyId: '',
          selectedTradingMode: 'backtest',
          selectedPlaybackId: '',
          selectedRangeDays: 30,
          selectedTradeType: 'all',
          detail: null,
          markerEvents: [],
          backtestPlaybacks: [],
          replayTimer: null,
          replayIndex: 0,
          modalPrevOverflow: '',
        };
        const FEATURE_FILTER_PRESET_KEY = String(constants.FEATURE_FILTER_PRESET_KEY || 'thunderclaw.strategy.feature.presets.v1');
        const featureTaxonomyConfig = typeof getStrategyFeatureConfigRuntime === 'function'
          ? getStrategyFeatureConfigRuntime()
          : null;
        let featureModalPrevOverflow = '';

        function switchStrategyLabTab(tabKeyLike) {
          const tabKey = String(tabKeyLike || '').trim() || 'feature';
          closeFeatureDetailModal();
          closeStrategyDetailModal();
          tabButtons.forEach(function(btn) {
            btn.classList.toggle('active', String(btn.getAttribute('data-sl-tab') || '') === tabKey);
          });
          if (featurePanelEl) featurePanelEl.classList.toggle('active', tabKey === 'feature');
          if (strategyPanelEl) strategyPanelEl.classList.toggle('active', tabKey === 'strategy');
          if (labPanelEl) labPanelEl.classList.toggle('active', tabKey === 'lab');
          if (backtestCoreEl) backtestCoreEl.style.display = tabKey === 'lab' ? '' : 'none';
        }
        const featureKeyOf = function(featureLike) {
          const feature = featureLike && typeof featureLike === 'object' ? featureLike : {};
          return String(feature.featureId || feature.name || '').trim();
        };
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
            return;
          }
          if (String(ev?.key || '') === 'Escape' && strategyDetailModalEl && !strategyDetailModalEl.hidden) {
            closeStrategyDetailModal();
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
        function setStrategyOpsStatus(textLike, kindLike) {
          setStatus(strategyOpsStatusTextEl, textLike, kindLike);
        }
        function setStrategyDetailStatus(textLike, kindLike) {
          setStatus(strategyDetailStatusEl, textLike, kindLike);
        }
        function clearStrategyReplayTimer() {
          if (strategyOpsState.replayTimer) {
            clearInterval(strategyOpsState.replayTimer);
            strategyOpsState.replayTimer = null;
          }
          if (strategyDetailPlayToggleBtn) strategyDetailPlayToggleBtn.textContent = '播放回放';
        }
        function collectStrategyOpsQuery() {
          return {
            q: String(strategyOpsQEl?.value || '').trim(),
            status: String(strategyOpsStatusEl?.value || '').trim(),
            sortBy: String(strategyOpsSortByEl?.value || 'updatedAt').trim() || 'updatedAt',
            sortOrder: String(strategyOpsSortOrderEl?.value || 'desc').trim() || 'desc',
            page: Math.max(1, Number(strategyOpsState.page || 1) || 1),
            pageSize: Math.max(5, Math.min(100, Number(strategyOpsPageSizeEl?.value || strategyOpsState.pageSize || 20) || 20)),
          };
        }
        function renderStrategyOpsPagination(payloadLike) {
          const payload = payloadLike && typeof payloadLike === 'object' ? payloadLike : {};
          strategyOpsState.page = Math.max(1, Number(payload.page || strategyOpsState.page || 1) || 1);
          strategyOpsState.pageSize = Math.max(5, Math.min(100, Number(payload.pageSize || strategyOpsState.pageSize || 20) || 20));
          strategyOpsState.totalPages = Math.max(1, Number(payload.totalPages || 1) || 1);
          strategyOpsState.total = Math.max(0, Number(payload.total || 0) || 0);
          if (strategyOpsPageInfoEl) {
            strategyOpsPageInfoEl.textContent = '第 ' + String(strategyOpsState.page) + '/' + String(strategyOpsState.totalPages) + ' 页 · 共 ' + String(strategyOpsState.total) + ' 条';
          }
          if (strategyOpsPrevBtn) strategyOpsPrevBtn.disabled = strategyOpsState.page <= 1;
          if (strategyOpsNextBtn) strategyOpsNextBtn.disabled = strategyOpsState.page >= strategyOpsState.totalPages;
        }
        async function fetchStrategiesOps() {
          const q = collectStrategyOpsQuery();
          strategyOpsState.pageSize = q.pageSize;
          if (fetchStrategyEntities) {
            return fetchStrategyEntities(q);
          }
          const url = '/api/strategy/entities'
            + '?q=' + encodeURIComponent(q.q)
            + '&status=' + encodeURIComponent(q.status)
            + '&sortBy=' + encodeURIComponent(q.sortBy)
            + '&sortOrder=' + encodeURIComponent(q.sortOrder)
            + '&page=' + encodeURIComponent(String(q.page))
            + '&pageSize=' + encodeURIComponent(String(q.pageSize));
          const resp = await fetch(url, { cache: 'no-store' });
          return readJsonResponse(resp);
        }
        function renderStrategyOpsList(rowsLike) {
          const rows = Array.isArray(rowsLike) ? rowsLike : [];
          strategyOpsState.rows = rows;
          if (!strategyOpsListEl) return;
          const renderer = globalObj.strategyOpsRuntime && typeof globalObj.strategyOpsRuntime.renderStrategyListRuntime === 'function'
            ? globalObj.strategyOpsRuntime.renderStrategyListRuntime
            : null;
          if (renderer) {
            strategyOpsListEl.innerHTML = renderer(rows);
            return;
          }
          strategyOpsListEl.innerHTML = rows.length
            ? rows.map(function(item) {
              const name = escapeHtml(String(item?.name || item?.strategyId || '-'));
              return '<div class="strategy-ops-item" data-sl-strategy-id="' + escapeHtml(String(item?.strategyId || '')) + '"><div class="name">' + name + '</div></div>';
            }).join('')
            : '<div class="strategy-ops-item"><div class="name">暂无策略</div></div>';
        }
        async function reloadStrategyOpsList() {
          if (!strategyOpsListEl) return;
          setStrategyOpsStatus('加载策略控制台...', '');
          try {
            const payload = await fetchStrategiesOps();
            renderStrategyOpsList(Array.isArray(payload?.strategies) ? payload.strategies : []);
            renderStrategyOpsPagination(payload || {});
            setStrategyOpsStatus('控制台已更新：' + String(Number(payload?.total || 0)) + ' 条策略。', 'ok');
          } catch (err) {
            setStrategyOpsStatus('控制台加载失败：' + String(err?.message || err), 'err');
          }
        }
        function closeStrategyDetailModal() {
          clearStrategyReplayTimer();
          if (!strategyDetailModalEl || strategyDetailModalEl.hidden) return;
          strategyDetailModalEl.hidden = true;
          strategyOpsState.detail = null;
          strategyOpsState.markerEvents = [];
          strategyOpsState.selectedStrategyId = '';
          strategyOpsState.selectedPlaybackId = '';
          strategyOpsState.backtestPlaybacks = [];
          if (strategyDetailBodyEl) strategyDetailBodyEl.innerHTML = '';
          if (strategyDetailTitleEl) strategyDetailTitleEl.textContent = '策略详情';
          if (strategyDetailMetaEl) strategyDetailMetaEl.textContent = '';
          if (document.body && document.body.getAttribute('data-strategy-modal-locked') === '1') {
            document.body.style.overflow = strategyOpsState.modalPrevOverflow || '';
            document.body.removeAttribute('data-strategy-modal-locked');
          }
        }
        function showStrategyTradePopover(indexLike, focusOnlyLike) {
          const index = Number(indexLike);
          if (!Number.isFinite(index) || index < 0) return;
          const list = Array.isArray(strategyOpsState.markerEvents) ? strategyOpsState.markerEvents : [];
          const trade = list[index];
          if (!trade || !strategyDetailBodyEl) return;
          const chart = strategyDetailBodyEl.querySelector('[data-sl-chart="kline"]');
          if (!chart) return;
          const marker = chart.querySelector('.strategy-trade-marker[data-trade-index="' + String(index) + '"]');
          const popover = chart.querySelector('#sl-strategy-trade-popover');
          if (!marker || !popover) return;
          if (globalObj.strategyOpsRuntime && typeof globalObj.strategyOpsRuntime.renderTradePopoverRuntime === 'function') {
            popover.innerHTML = globalObj.strategyOpsRuntime.renderTradePopoverRuntime(trade);
          } else {
            popover.textContent = String(trade?.tradeType || '-') + ' @ ' + String(trade?.price || '-');
          }
          const x = Number(marker.getAttribute('cx') || 0);
          const y = Number(marker.getAttribute('cy') || 0);
          const left = Math.max(8, Math.min(chart.clientWidth - 230, x + 12));
          const top = Math.max(8, Math.min(chart.clientHeight - 120, y - 14));
          popover.style.left = String(left) + 'px';
          popover.style.top = String(top) + 'px';
          popover.classList.add('show');
          chart.querySelectorAll('.strategy-trade-marker[data-active="1"]').forEach(function(node) {
            node.removeAttribute('data-active');
            node.setAttribute('r', '4.2');
            node.setAttribute('stroke-width', '1.2');
          });
          marker.setAttribute('data-active', '1');
          marker.setAttribute('r', '6.2');
          marker.setAttribute('stroke-width', '1.8');
          if (!focusOnlyLike && marker.scrollIntoView) {
            marker.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          }
        }
        function bindStrategyDetailInteractions() {
          if (!strategyDetailBodyEl) return;
          const chart = strategyDetailBodyEl.querySelector('[data-sl-chart="kline"]');
          if (chart) {
            chart.querySelectorAll('.strategy-trade-marker').forEach(function(node) {
              node.addEventListener('click', function(ev) {
                ev.preventDefault();
                const idx = Number(node.getAttribute('data-trade-index') || '');
                showStrategyTradePopover(idx);
              });
            });
          }
          const editorSaveBtn = strategyDetailBodyEl.querySelector('[data-sl-editor-action="save"]');
          if (editorSaveBtn) {
            editorSaveBtn.addEventListener('click', function() {
              void saveStrategyDraftFromEditor();
            });
          }
          strategyDetailBodyEl.querySelectorAll('[data-sl-trading-mode]').forEach(function(btn) {
            btn.addEventListener('click', function(ev) {
              ev.preventDefault();
              if (!strategyOpsState.selectedStrategyId) return;
              const mode = String(btn.getAttribute('data-sl-trading-mode') || '').trim().toLowerCase();
              if (!mode) return;
              strategyOpsState.selectedTradingMode = mode;
              if (mode !== 'backtest') {
                strategyOpsState.selectedPlaybackId = '';
              } else if (!strategyOpsState.selectedPlaybackId) {
                const firstPlayback = Array.isArray(strategyOpsState.backtestPlaybacks) ? strategyOpsState.backtestPlaybacks[0] : null;
                strategyOpsState.selectedPlaybackId = String(firstPlayback?.playbackId || '');
              }
              void openStrategyDetail(strategyOpsState.selectedStrategyId, {
                keepOpen: true,
                rangeDays: strategyOpsState.selectedRangeDays,
                tradeType: strategyOpsState.selectedTradeType,
                tradingMode: strategyOpsState.selectedTradingMode,
                playbackId: strategyOpsState.selectedPlaybackId,
              });
            });
          });
          strategyDetailBodyEl.querySelectorAll('[data-sl-playback-id]').forEach(function(btn) {
            btn.addEventListener('click', function(ev) {
              ev.preventDefault();
              if (!strategyOpsState.selectedStrategyId) return;
              const playbackId = String(btn.getAttribute('data-sl-playback-id') || '').trim();
              if (!playbackId) return;
              strategyOpsState.selectedTradingMode = 'backtest';
              strategyOpsState.selectedPlaybackId = playbackId;
              void openStrategyDetail(strategyOpsState.selectedStrategyId, {
                keepOpen: true,
                rangeDays: strategyOpsState.selectedRangeDays,
                tradeType: strategyOpsState.selectedTradeType,
                tradingMode: 'backtest',
                playbackId: playbackId,
              });
            });
          });
        }
        function collectStrategyEditorPayload() {
          if (!strategyDetailBodyEl) return null;
          const detail = strategyOpsState.detail && typeof strategyOpsState.detail === 'object'
            ? strategyOpsState.detail
            : null;
          if (!detail || !detail.strategy) return null;
          const getField = function(fieldLike) {
            const node = strategyDetailBodyEl.querySelector('[data-sl-edit-field="' + String(fieldLike || '') + '"]');
            return String(node?.value || '').trim();
          };
          const parseFeatureRefs = function(inputLike) {
            const raw = String(inputLike || '');
            const out = [];
            let token = '';
            const pushToken = function() {
              const value = String(token || '').trim();
              token = '';
              if (!value) return;
              if (out.includes(value)) return;
              out.push(value);
            };
            for (let i = 0; i < raw.length; i += 1) {
              const ch = raw[i];
              if (ch === ',' || ch === ';' || ch === '\n' || ch === '\r' || ch === '|' || ch === '/') {
                pushToken();
              } else {
                token += ch;
              }
            }
            pushToken();
            return out.slice(0, 32);
          };
          const featureRefs = parseFeatureRefs(getField('featureRefs'));
          const signalLogic = getField('signalLogic');
          const riskPauseCondition = getField('riskPauseCondition');
          const version = detail.version && typeof detail.version === 'object' ? detail.version : {};
          const positionLayer = version.positionLayer && typeof version.positionLayer === 'object' ? version.positionLayer : {};
          const executionLayer = version.executionLayer && typeof version.executionLayer === 'object' ? version.executionLayer : {};
          const riskLayer = version.riskLayer && typeof version.riskLayer === 'object' ? version.riskLayer : {};
          return {
            strategyId: String(detail.strategy.strategyId || ''),
            name: getField('name') || String(detail.strategy.name || ''),
            description: getField('description') || String(detail.strategy.description || ''),
            signalLayer: {
              featureRefs: featureRefs,
              signalLogic: signalLogic || String(version?.signalLayer?.signalLogic || ''),
              params: version?.signalLayer?.params && typeof version.signalLayer.params === 'object'
                ? version.signalLayer.params
                : {},
            },
            positionLayer: positionLayer,
            executionLayer: executionLayer,
            riskLayer: {
              ...riskLayer,
              riskPauseCondition: riskPauseCondition || String(riskLayer.riskPauseCondition || ''),
            },
            source: 'strategy_console',
            reason: '编辑器保存草稿',
          };
        }
        async function saveStrategyDraftFromEditor() {
          const payload = collectStrategyEditorPayload();
          if (!payload || !payload.strategyId) {
            setStrategyDetailStatus('保存失败：策略ID缺失。', 'err');
            return;
          }
          if (!postStrategyDraftSave) {
            setStrategyDetailStatus('保存失败：草稿保存接口未加载。', 'err');
            return;
          }
          setStrategyDetailStatus('正在保存草稿...', '');
          try {
            await postStrategyDraftSave(payload);
            setStrategyDetailStatus('草稿保存成功。', 'ok');
            await reloadStrategyOpsList();
            await openStrategyDetail(payload.strategyId, {
              keepOpen: true,
              rangeDays: strategyOpsState.selectedRangeDays,
              tradeType: strategyOpsState.selectedTradeType,
              tradingMode: strategyOpsState.selectedTradingMode,
              playbackId: strategyOpsState.selectedPlaybackId,
            });
          } catch (err) {
            setStrategyDetailStatus('保存失败：' + String(err?.message || err), 'err');
          }
        }
        async function openStrategyDetail(strategyIdLike, optionsLike) {
          const strategyId = String(strategyIdLike || '').trim();
          if (!strategyId || !strategyDetailModalEl || !strategyDetailBodyEl) return;
          const options = optionsLike && typeof optionsLike === 'object' ? optionsLike : {};
          const rangeDays = Math.max(1, Math.min(365, Number(options.rangeDays || strategyOpsState.selectedRangeDays || 30) || 30));
          const tradeType = String(options.tradeType || strategyOpsState.selectedTradeType || 'all');
          const isSwitchingStrategy = String(strategyOpsState.selectedStrategyId || '').trim() !== strategyId;
          const explicitTradingModeRaw = String(options.tradingMode || '').trim().toLowerCase();
          const fallbackTradingModeRaw = isSwitchingStrategy ? '' : String(strategyOpsState.selectedTradingMode || '').trim().toLowerCase();
          const tradingModeCandidate = explicitTradingModeRaw || fallbackTradingModeRaw;
          const tradingMode = tradingModeCandidate === 'live' || tradingModeCandidate === 'paper' || tradingModeCandidate === 'backtest'
            ? tradingModeCandidate
            : '';
          const playbackId = String(options.playbackId || (isSwitchingStrategy ? '' : strategyOpsState.selectedPlaybackId) || '').trim();
          strategyOpsState.selectedRangeDays = rangeDays;
          strategyOpsState.selectedTradeType = tradeType;
          if (tradingMode) strategyOpsState.selectedTradingMode = tradingMode;
          if (playbackId || !isSwitchingStrategy) strategyOpsState.selectedPlaybackId = playbackId;
          strategyOpsState.selectedStrategyId = strategyId;
          setStrategyDetailStatus('加载策略详情中...', '');
          try {
            const detailPayload = fetchStrategyEntityDetail
              ? await fetchStrategyEntityDetail({
                strategyId: strategyId,
                rangeDays: rangeDays,
                tradeType: tradeType,
                tradingMode: tradingMode,
                playbackId: playbackId,
              })
              : await (async function() {
                const resp = await fetch('/api/strategy/entities/detail?strategyId=' + encodeURIComponent(strategyId)
                  + '&rangeDays=' + encodeURIComponent(String(rangeDays))
                  + '&tradeType=' + encodeURIComponent(tradeType)
                  + '&tradingMode=' + encodeURIComponent(tradingMode)
                  + '&playbackId=' + encodeURIComponent(playbackId), { cache: 'no-store' });
                return readJsonResponse(resp);
              })();
            const auditsPayload = fetchStrategyEntityAudits
              ? await fetchStrategyEntityAudits({ strategyId: strategyId, limit: 80 }).catch(function() { return { audits: [] }; })
              : { audits: [] };
            const detail = detailPayload && typeof detailPayload === 'object' ? detailPayload : {};
            detail.audits = Array.isArray(detail?.audits) ? detail.audits : (Array.isArray(auditsPayload?.audits) ? auditsPayload.audits : []);
            strategyOpsState.detail = detail;
            const tradingMeta = detail?.trading && typeof detail.trading === 'object' ? detail.trading : {};
            const detailModeRaw = String(tradingMeta.mode || tradingMode || 'backtest').trim().toLowerCase();
            strategyOpsState.selectedTradingMode = detailModeRaw === 'live' || detailModeRaw === 'paper' || detailModeRaw === 'backtest'
              ? detailModeRaw
              : 'backtest';
            strategyOpsState.backtestPlaybacks = Array.isArray(tradingMeta.backtestPlaybacks)
              ? tradingMeta.backtestPlaybacks
              : [];
            if (strategyOpsState.selectedTradingMode === 'backtest') {
              const firstPlayback = strategyOpsState.backtestPlaybacks[0];
              strategyOpsState.selectedPlaybackId = String(
                tradingMeta.selectedPlaybackId
                || playbackId
                || firstPlayback?.playbackId
                || '',
              ).trim();
            } else {
              strategyOpsState.selectedPlaybackId = '';
            }
            if (strategyDetailTitleEl) strategyDetailTitleEl.textContent = String(detail?.strategy?.name || '策略详情');
            if (strategyDetailMetaEl) {
              strategyDetailMetaEl.textContent = '状态：' + String(detail?.strategy?.statusLabel || detail?.strategy?.status || '-')
                + ' · 环境：' + String(detail?.strategy?.runtimeEnvLabel || detail?.strategy?.runtimeEnv || '-')
                + ' · 当前版本：' + String(detail?.strategy?.currentVersionId || detail?.strategy?.latestVersionId || '-');
            }
            if (strategyDetailTradeFilterEl) strategyDetailTradeFilterEl.value = tradeType;
            strategyDetailRangeBtns.forEach(function(btn) {
              btn.classList.toggle('active', Number(btn.getAttribute('data-sl-range') || '') === rangeDays);
            });
            if (strategyDetailRangeCustomEl) strategyDetailRangeCustomEl.value = String(rangeDays);
            const renderer = globalObj.strategyOpsRuntime && typeof globalObj.strategyOpsRuntime.renderStrategyDetailRuntime === 'function'
              ? globalObj.strategyOpsRuntime.renderStrategyDetailRuntime
              : null;
            if (renderer) {
              const rendered = renderer(detail, {
                rangeDays: rangeDays,
                tradeType: tradeType,
                tradingMode: strategyOpsState.selectedTradingMode,
                playbackId: strategyOpsState.selectedPlaybackId,
                ohlcvByTf: OHLCV_BY_TF || {},
              });
              strategyDetailBodyEl.innerHTML = String(rendered?.html || '');
              strategyOpsState.markerEvents = Array.isArray(rendered?.markerEvents) ? rendered.markerEvents : [];
            } else {
              strategyDetailBodyEl.innerHTML = '<div class="strategy-detail-editor">策略详情渲染模块未加载。</div>';
              strategyOpsState.markerEvents = [];
            }
            bindStrategyDetailInteractions();
            strategyDetailModalEl.hidden = false;
            strategyDetailBodyEl.scrollTop = 0;
            if (document.body && document.body.getAttribute('data-strategy-modal-locked') !== '1') {
              strategyOpsState.modalPrevOverflow = String(document.body.style.overflow || '');
              document.body.style.overflow = 'hidden';
              document.body.setAttribute('data-strategy-modal-locked', '1');
            }
            setStrategyDetailStatus('详情已更新。', 'ok');
          } catch (err) {
            setStrategyDetailStatus('加载失败：' + String(err?.message || err), 'err');
          }
        }
        async function doStrategyStatusAction(strategyIdLike, targetStatusLike, actionLike, reasonLike) {
          const strategyId = String(strategyIdLike || '').trim();
          if (!strategyId || !postStrategyStatus) {
            setStrategyOpsStatus('状态操作失败：接口未就绪。', 'err');
            return;
          }
          try {
            await postStrategyStatus({
              strategyId: strategyId,
              targetStatus: String(targetStatusLike || '').trim(),
              action: String(actionLike || '').trim(),
              reason: String(reasonLike || '').trim(),
              source: 'strategy_console',
            });
            const targetStatus = String(targetStatusLike || '').trim().toLowerCase();
            if (targetStatus === 'paper_live') {
              strategyOpsState.selectedTradingMode = 'paper';
              strategyOpsState.selectedPlaybackId = '';
            } else if (targetStatus === 'live' || targetStatus === 'risk_paused') {
              strategyOpsState.selectedTradingMode = 'live';
              strategyOpsState.selectedPlaybackId = '';
            } else if (targetStatus === 'backtested' || targetStatus === 'draft') {
              strategyOpsState.selectedTradingMode = 'backtest';
            }
            setStrategyOpsStatus('状态已更新。', 'ok');
            await reloadStrategyOpsList();
            if (strategyOpsState.selectedStrategyId === strategyId && !strategyDetailModalEl?.hidden) {
              await openStrategyDetail(strategyId, {
                keepOpen: true,
                rangeDays: strategyOpsState.selectedRangeDays,
                tradeType: strategyOpsState.selectedTradeType,
                tradingMode: strategyOpsState.selectedTradingMode,
                playbackId: strategyOpsState.selectedPlaybackId,
              });
            }
          } catch (err) {
            setStrategyOpsStatus('状态更新失败：' + String(err?.message || err), 'err');
          }
        }
        async function doStrategyPublishAction(strategyIdLike) {
          const strategyId = String(strategyIdLike || '').trim();
          if (!strategyId || !postStrategyPublish) {
            setStrategyOpsStatus('发布失败：接口未就绪。', 'err');
            return;
          }
          const latestBacktest = typeof getLatestBacktestResult === 'function' ? getLatestBacktestResult() : null;
          const performance = latestBacktest && typeof latestBacktest === 'object'
            ? {
              latestReturnPct: Number(latestBacktest.netPnlPct || latestBacktest.totalPnlPct || 0) || 0,
              maxDrawdownPct: Number(latestBacktest.maxDrawdownPct || 0) || 0,
              winRate: Number(latestBacktest.winRate || 0) || 0,
              tradeCount: Number(latestBacktest.tradeCount || latestBacktest.trades || 0) || 0,
            }
            : {};
          try {
            await postStrategyPublish({
              strategyId: strategyId,
              note: '控制台发布新版本',
              performance: performance,
              source: 'strategy_console',
            });
            setStrategyOpsStatus('已发布新版本。', 'ok');
            await reloadStrategyOpsList();
            if (strategyOpsState.selectedStrategyId === strategyId && !strategyDetailModalEl?.hidden) {
              await openStrategyDetail(strategyId, {
                keepOpen: true,
                rangeDays: strategyOpsState.selectedRangeDays,
                tradeType: strategyOpsState.selectedTradeType,
                tradingMode: strategyOpsState.selectedTradingMode,
                playbackId: strategyOpsState.selectedPlaybackId,
              });
            }
          } catch (err) {
            setStrategyOpsStatus('发布失败：' + String(err?.message || err), 'err');
          }
        }
        async function createNewStrategyDraft() {
          if (!postStrategyDraftSave) {
            setStrategyOpsStatus('新建失败：草稿接口未加载。', 'err');
            return;
          }
          const now = new Date();
          const name = '对话策略草稿-' + String(now.getMonth() + 1).padStart(2, '0')
            + String(now.getDate()).padStart(2, '0')
            + '-' + String(now.getHours()).padStart(2, '0')
            + String(now.getMinutes()).padStart(2, '0');
          try {
            const out = await postStrategyDraftSave({
              name: name,
              description: '新建策略草稿，可在详情编辑器继续完善。',
              signalLayer: { featureRefs: [], signalLogic: '待补充', params: {} },
              positionLayer: {},
              riskLayer: {},
              executionLayer: {},
              source: 'strategy_console',
              reason: '新建策略草稿',
            });
            setStrategyOpsStatus('已创建草稿：' + String(out?.strategy?.name || name), 'ok');
            await reloadStrategyOpsList();
            if (out?.strategy?.strategyId) {
              await openStrategyDetail(out.strategy.strategyId, {
                keepOpen: true,
                rangeDays: strategyOpsState.selectedRangeDays,
                tradeType: strategyOpsState.selectedTradeType,
                tradingMode: strategyOpsState.selectedTradingMode,
                playbackId: strategyOpsState.selectedPlaybackId,
              });
            }
          } catch (err) {
            setStrategyOpsStatus('新建失败：' + String(err?.message || err), 'err');
          }
        }
        function toggleStrategyReplay() {
          if (!strategyDetailBodyEl) return;
          const events = Array.isArray(strategyOpsState.markerEvents) ? strategyOpsState.markerEvents : [];
          if (!events.length) {
            setStrategyDetailStatus('暂无可回放交易点。', 'err');
            return;
          }
          if (strategyOpsState.replayTimer) {
            clearStrategyReplayTimer();
            setStrategyDetailStatus('已暂停回放。', 'ok');
            return;
          }
          const speedMs = Math.max(120, Math.min(3000, Number(strategyDetailPlaySpeedEl?.value || 520) || 520));
          strategyDetailPlayToggleBtn.textContent = '暂停回放';
          strategyOpsState.replayTimer = setInterval(function() {
            if (!Array.isArray(strategyOpsState.markerEvents) || !strategyOpsState.markerEvents.length) {
              clearStrategyReplayTimer();
              return;
            }
            if (strategyOpsState.replayIndex >= strategyOpsState.markerEvents.length) {
              strategyOpsState.replayIndex = 0;
            }
            showStrategyTradePopover(strategyOpsState.replayIndex, true);
            strategyOpsState.replayIndex += 1;
          }, speedMs);
          setStrategyDetailStatus('回放中...', 'ok');
        }
        function resetStrategyReplay() {
          clearStrategyReplayTimer();
          strategyOpsState.replayIndex = 0;
          const chart = strategyDetailBodyEl?.querySelector('[data-sl-chart="kline"]');
          const popover = chart?.querySelector('#sl-strategy-trade-popover');
          if (popover) popover.classList.remove('show');
          setStrategyDetailStatus('已重置回放指针。', 'ok');
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
          const rows = readLocalJson(FEATURE_FILTER_PRESET_KEY, []);
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
          writeLocalJson(FEATURE_FILTER_PRESET_KEY, featureViewState.presets);
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
        // 特征详情与分类可视化已拆分到 ./js/modules/strategy-feature-runtime.js
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
          if (fetchStrategyFeatures) {
            return fetchStrategyFeatures({
              q: q,
              mainCategory: mainCategory,
              tag: tag,
              source: source,
              enabled: enabled,
              sortBy: sortBy,
              sortOrder: sortOrder,
              page: featureViewState.page,
              pageSize: pageSize,
            });
          }
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
          return readJsonResponse(resp);
        }
        async function fetchVersions() {
          if (fetchStrategyVersions) {
            return fetchStrategyVersions(80);
          }
          const resp = await fetch('/api/strategy/versions?limit=80', { cache: 'no-store' });
          return readJsonResponse(resp);
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
            if (strategyOpsListEl) {
              await reloadStrategyOpsList();
            }
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
            .then(readJsonResponse)
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

        if (strategyOpsListEl) {
          strategyOpsListEl.addEventListener('click', function(ev) {
            const actionBtn = ev.target && ev.target.closest
              ? ev.target.closest('[data-sl-action]')
              : null;
            if (!actionBtn) return;
            ev.preventDefault();
            const card = actionBtn.closest('[data-sl-strategy-id]');
            const strategyId = String(card?.getAttribute('data-sl-strategy-id') || '').trim();
            const action = String(actionBtn.getAttribute('data-sl-action') || '').trim();
            if (!strategyId || !action) return;
            if (action === 'detail') {
              void openStrategyDetail(strategyId, { keepOpen: true });
              return;
            }
            if (action === 'publish') {
              void doStrategyPublishAction(strategyId);
              return;
            }
            if (action === 'start-paper') {
              void doStrategyStatusAction(strategyId, 'paper_live', 'start_paper', '控制台启动模拟');
              return;
            }
            if (action === 'start-live') {
              void doStrategyStatusAction(strategyId, 'live', 'start_live', '控制台启动实盘');
              return;
            }
            if (action === 'pause') {
              void doStrategyStatusAction(strategyId, 'paused', 'pause', '控制台手动暂停');
            }
          });
        }
        if (strategyOpsRefreshBtn) {
          strategyOpsRefreshBtn.addEventListener('click', function() {
            void reloadStrategyOpsList();
          });
        }
        if (strategyOpsNewDraftBtn) {
          strategyOpsNewDraftBtn.addEventListener('click', function() {
            void createNewStrategyDraft();
          });
        }
        if (strategyOpsPrevBtn) {
          strategyOpsPrevBtn.addEventListener('click', function() {
            if (strategyOpsState.page <= 1) return;
            strategyOpsState.page -= 1;
            void reloadStrategyOpsList();
          });
        }
        if (strategyOpsNextBtn) {
          strategyOpsNextBtn.addEventListener('click', function() {
            if (strategyOpsState.page >= strategyOpsState.totalPages) return;
            strategyOpsState.page += 1;
            void reloadStrategyOpsList();
          });
        }
        if (strategyOpsPageSizeEl) {
          strategyOpsPageSizeEl.addEventListener('change', function() {
            strategyOpsState.page = 1;
            strategyOpsState.pageSize = Math.max(5, Math.min(100, Number(strategyOpsPageSizeEl.value || 20) || 20));
            void reloadStrategyOpsList();
          });
        }
        if (strategyOpsStatusEl) {
          strategyOpsStatusEl.addEventListener('change', function() {
            strategyOpsState.page = 1;
            void reloadStrategyOpsList();
          });
        }
        if (strategyOpsSortByEl) {
          strategyOpsSortByEl.addEventListener('change', function() {
            strategyOpsState.page = 1;
            void reloadStrategyOpsList();
          });
        }
        if (strategyOpsSortOrderEl) {
          strategyOpsSortOrderEl.addEventListener('change', function() {
            strategyOpsState.page = 1;
            void reloadStrategyOpsList();
          });
        }
        if (strategyOpsQEl) {
          let strategySearchTimer = null;
          strategyOpsQEl.addEventListener('input', function() {
            if (strategySearchTimer) clearTimeout(strategySearchTimer);
            strategySearchTimer = window.setTimeout(function() {
              strategyOpsState.page = 1;
              void reloadStrategyOpsList();
            }, 260);
          });
        }
        if (strategyDetailCloseBtn) {
          strategyDetailCloseBtn.addEventListener('click', function() {
            closeStrategyDetailModal();
          });
        }
        if (strategyDetailModalEl) {
          strategyDetailModalEl.addEventListener('click', function(ev) {
            const dialog = ev.target && ev.target.closest ? ev.target.closest('.strategy-detail-dialog') : null;
            if (!dialog) closeStrategyDetailModal();
          });
        }
        strategyDetailRangeBtns.forEach(function(btn) {
          btn.addEventListener('click', function() {
            const days = Math.max(1, Math.min(365, Number(btn.getAttribute('data-sl-range') || 30) || 30));
            if (!strategyOpsState.selectedStrategyId) return;
            strategyDetailRangeBtns.forEach(function(x) { x.classList.toggle('active', x === btn); });
            strategyOpsState.selectedRangeDays = days;
            void openStrategyDetail(strategyOpsState.selectedStrategyId, {
              keepOpen: true,
              rangeDays: days,
              tradeType: strategyOpsState.selectedTradeType,
              tradingMode: strategyOpsState.selectedTradingMode,
              playbackId: strategyOpsState.selectedPlaybackId,
            });
          });
        });
        if (strategyDetailRangeApplyBtn) {
          strategyDetailRangeApplyBtn.addEventListener('click', function() {
            if (!strategyOpsState.selectedStrategyId) return;
            const days = Math.max(1, Math.min(365, Number(strategyDetailRangeCustomEl?.value || 30) || 30));
            strategyOpsState.selectedRangeDays = days;
            void openStrategyDetail(strategyOpsState.selectedStrategyId, {
              keepOpen: true,
              rangeDays: days,
              tradeType: strategyOpsState.selectedTradeType,
              tradingMode: strategyOpsState.selectedTradingMode,
              playbackId: strategyOpsState.selectedPlaybackId,
            });
          });
        }
        if (strategyDetailTradeFilterEl) {
          strategyDetailTradeFilterEl.addEventListener('change', function() {
            if (!strategyOpsState.selectedStrategyId) return;
            strategyOpsState.selectedTradeType = String(strategyDetailTradeFilterEl.value || 'all');
            void openStrategyDetail(strategyOpsState.selectedStrategyId, {
              keepOpen: true,
              rangeDays: strategyOpsState.selectedRangeDays,
              tradeType: strategyOpsState.selectedTradeType,
              tradingMode: strategyOpsState.selectedTradingMode,
              playbackId: strategyOpsState.selectedPlaybackId,
            });
          });
        }
        if (strategyDetailPlayToggleBtn) {
          strategyDetailPlayToggleBtn.addEventListener('click', function() {
            toggleStrategyReplay();
          });
        }
        if (strategyDetailPlayResetBtn) {
          strategyDetailPlayResetBtn.addEventListener('click', function() {
            resetStrategyReplay();
          });
        }
        if (strategyDetailSaveBtn) {
          strategyDetailSaveBtn.addEventListener('click', function() {
            void saveStrategyDraftFromEditor();
          });
        }
        if (strategyDetailPublishBtn) {
          strategyDetailPublishBtn.addEventListener('click', function() {
            if (!strategyOpsState.selectedStrategyId) return;
            void doStrategyPublishAction(strategyOpsState.selectedStrategyId);
          });
        }
        if (strategyDetailStartPaperBtn) {
          strategyDetailStartPaperBtn.addEventListener('click', function() {
            if (!strategyOpsState.selectedStrategyId) return;
            void doStrategyStatusAction(strategyOpsState.selectedStrategyId, 'paper_live', 'start_paper', '详情面板启动模拟');
          });
        }
        if (strategyDetailStartLiveBtn) {
          strategyDetailStartLiveBtn.addEventListener('click', function() {
            if (!strategyOpsState.selectedStrategyId) return;
            void doStrategyStatusAction(strategyOpsState.selectedStrategyId, 'live', 'start_live', '详情面板启动实盘');
          });
        }
        if (strategyDetailPauseBtn) {
          strategyDetailPauseBtn.addEventListener('click', function() {
            if (!strategyOpsState.selectedStrategyId) return;
            void doStrategyStatusAction(strategyOpsState.selectedStrategyId, 'paused', 'pause', '详情面板手动暂停');
          });
        }
        if (strategyDetailRiskPauseBtn) {
          strategyDetailRiskPauseBtn.addEventListener('click', function() {
            if (!strategyOpsState.selectedStrategyId) return;
            void doStrategyStatusAction(strategyOpsState.selectedStrategyId, 'risk_paused', 'risk_pause', '详情面板风控暂停');
          });
        }

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
            .then(readJsonResponse)
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
          setStrategyOpsStatus(hint, 'ok');
          void reloadAll().then(function() {
            const openEditor = Boolean(detail?.openEditor);
            const strategyId = String(detail?.strategyId || detail?.applied?.strategy?.strategyId || '').trim();
            if (openEditor && strategyId) {
              try { switchView('backtest'); } catch (_) {}
              switchStrategyLabTab('strategy');
              void openStrategyDetail(strategyId, {
                keepOpen: true,
                rangeDays: strategyOpsState.selectedRangeDays,
                tradeType: strategyOpsState.selectedTradeType,
                tradingMode: strategyOpsState.selectedTradingMode,
                playbackId: strategyOpsState.selectedPlaybackId,
              });
            }
          });
        });

        void reloadAll();
      
  }

  globalObj.setupStrategyLabPanelRuntime = setupStrategyLabPanelRuntime;
})(typeof window !== 'undefined' ? window : this);
