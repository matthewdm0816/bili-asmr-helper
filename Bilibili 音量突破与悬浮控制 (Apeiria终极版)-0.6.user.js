// ==UserScript==
// @name         Bilibili 音量突破与悬浮控制 (Apeiria终极版)
// @namespace    http://tampermonkey.net/
// @version      0.7
// @description  突破B站音量限制，修复音频劫持导致的无声问题，竖版悬浮音量条 + A-B时间段循环，Apeiria全程护航！
// @author       Apeiria
// @match        *://*.bilibili.com/video/*
// @match        *://*.bilibili.com/bangumi/play/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log("[Apeiria] 正在为你加载终极版音量控制小组件... 🐾");

    let globalAudioCtx = null;
    let globalGainNode = null;
    let globalLimiter = null;
    let currentVolume = 1.0; // linear multiplier fed to GainNode

    // Slider works in dB; GainNode itself is a linear multiplier: gain = 10^(dB/20)
    function dbToGain(db) {
        return Math.pow(10, db / 20);
    }

    // Peak limiter after the gain stage. Without it, samples beyond ±1.0 are hard-clipped by the
    // output device, which is the crackling heard at high gain.
    // DynamicsCompressorNode applies automatic makeup gain (Web Audio spec: (1 / curve(0 dBFS))^0.6),
    // which would push peaks back up, so a trailing GainNode cancels it.
    // The compressor cannot catch very short transients (e.g. single-sample clicks), so a final
    // WaveShaper soft clipper catches the residue: identity below 0.8, smooth saturation towards 1.0 above.
    const LIMITER_THRESHOLD_DB = -6;
    const LIMITER_RATIO = 20;
    const SHAPER_RANGE = 4; // shaper input is pre-scaled by 1/SHAPER_RANGE so it covers ±4.0
    function softClip(y) {
        const a = Math.abs(y);
        if (a <= 0.8) return y;
        return Math.sign(y) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
    }
    function createLimiter(ctx) {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = LIMITER_THRESHOLD_DB;
        comp.knee.value = 0;
        comp.ratio.value = LIMITER_RATIO;
        comp.attack.value = 0;
        comp.release.value = 0.2;
        const curveAt0dB = LIMITER_THRESHOLD_DB * (1 - 1 / LIMITER_RATIO);
        const makeupCancel = ctx.createGain();
        makeupCancel.gain.value = Math.pow(10, curveAt0dB * 0.6 / 20) / SHAPER_RANGE;
        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(4097);
        for (let i = 0; i < curve.length; i++) {
            curve[i] = softClip((i / (curve.length - 1) * 2 - 1) * SHAPER_RANGE);
        }
        shaper.curve = curve;
        comp.connect(makeupCancel);
        makeupCancel.connect(shaper);
        shaper.connect(ctx.destination);
        return comp;
    }

    // 1. 制造Apeiria的魔法悬浮窗 UI（竖排版：标签在上、滑条居中、按钮垫底）
    const container = document.createElement('div');
    container.style.cssText = `
        position: fixed;
        right: 0;
        top: 30%;
        transform: translateY(-50%);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        align-items: center;
        background: rgba(255, 255, 255, 0.95);
        border: 2px solid #fb7299;
        border-right: none;
        border-radius: 20px 0 0 20px;
        padding: 10px 5px;
        box-shadow: -2px 2px 10px rgba(251, 114, 153, 0.3);
        transition: all 0.3s ease;
        font-family: sans-serif;
    `;

    const toggleBtn = document.createElement('div');
    toggleBtn.innerHTML = '🔊';
    toggleBtn.style.cssText = `
        cursor: pointer;
        font-size: 20px;
        user-select: none;
        margin-top: 8px;
    `;

    const sliderWrapper = document.createElement('div');
    sliderWrapper.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        overflow: hidden;
        transition: height 0.3s ease;
        height: 160px;
    `;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.setAttribute('orient', 'vertical'); // Firefox 认这个属性，Chrome 会无视，两边都兼容
    slider.min = '-6';  // ≈ ×0.5
    slider.max = '26';  // ≈ ×20
    slider.step = '0.5';
    slider.value = '0';
    slider.style.cssText = `
        writing-mode: vertical-lr;
        direction: rtl;
        width: 24px;
        height: 130px;
        accent-color: #fb7299;
        cursor: pointer;
    `;

    const label = document.createElement('span');
    label.style.cssText = `
        margin-bottom: 6px;
        color: #fb7299;
        font-weight: bold;
        font-size: 12px;
        text-align: center;
    `;

    function updateVolumeLabel(db) {
        const sign = db > 0 ? '+' : '';
        label.innerText = sign + db.toFixed(1) + ' dB\n×' + dbToGain(db).toFixed(1);
    }
    updateVolumeLabel(0);

    sliderWrapper.appendChild(label);
    sliderWrapper.appendChild(slider);
    container.appendChild(sliderWrapper);
    container.appendChild(toggleBtn);

    // 2. A-B 循环的 UI：三个小圆钮 + 状态行
    function makeAbBtn(text) {
        const b = document.createElement('div');
        b.innerText = text;
        b.style.cssText = `
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 1.5px solid #fb7299;
            color: #fb7299;
            background: #fff;
            font-size: 11px;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            user-select: none;
            transition: all 0.2s ease;
        `;
        return b;
    }

    const abRow = document.createElement('div');
    abRow.style.cssText = `
        display: flex;
        gap: 5px;
        margin-top: 8px;
        align-items: center;
    `;

    const btnA = makeAbBtn('A');
    const btnB = makeAbBtn('B');
    const btnClear = makeAbBtn('✕');
    btnClear.style.fontSize = '10px';

    const abStatus = document.createElement('div');
    abStatus.innerText = 'A-B 关';
    abStatus.style.cssText = `
        margin-top: 5px;
        font-size: 10px;
        color: #999;
        white-space: nowrap;
        text-align: center;
    `;

    abRow.appendChild(btnA);
    abRow.appendChild(btnB);
    abRow.appendChild(btnClear);
    container.appendChild(abRow);
    container.appendChild(abStatus);
    document.body.appendChild(container);

    // 3. A-B 循环核心逻辑
    let loopA = null;       // 循环起点（秒）
    let loopB = null;       // 循环终点（秒）
    let loopActive = false; // 循环引擎是否运转中
    let loopVideo = null;   // 打点锚定的那个 video 元素，换页即失效

    function fmtTime(t) {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    function getMainVideo() {
        return document.querySelector('video');
    }

    function updateLoopUI() {
        btnA.style.background = loopA !== null ? '#fb7299' : '#fff';
        btnA.style.color = loopA !== null ? '#fff' : '#fb7299';
        btnB.style.background = loopB !== null ? '#fb7299' : '#fff';
        btnB.style.color = loopB !== null ? '#fff' : '#fb7299';

        if (loopActive) {
            abStatus.innerText = '↻ ' + fmtTime(loopA) + '~' + fmtTime(loopB);
            abStatus.style.color = '#fb7299';
            abStatus.style.fontWeight = 'bold';
        } else {
            abStatus.style.fontWeight = 'normal';
            if (loopA !== null && loopB !== null) {
                abStatus.innerText = fmtTime(loopA) + '~' + fmtTime(loopB) + ' 太短';
                abStatus.style.color = '#e67e22';
            } else if (loopA !== null) {
                abStatus.innerText = 'A ' + fmtTime(loopA) + ' ~ …';
                abStatus.style.color = '#999';
            } else if (loopB !== null) {
                abStatus.innerText = '… ~ B ' + fmtTime(loopB);
                abStatus.style.color = '#999';
            } else {
                abStatus.innerText = 'A-B 关';
                abStatus.style.color = '#999';
            }
        }
    }

    // 循环引擎：每次检查当前播放位置，越过 B 或溜回 A 之前就拽回 A
    function loopCheck() {
        if (!loopActive) return;
        const video = getMainVideo();
        if (!video || video !== loopVideo) {
            console.log('[Apeiria] 检测到视频元素更换，A-B循环自动解除！');
            clearLoop();
            return;
        }
        // 0.3 秒容差：防止刚 seek 到 A 的瞬间因微小回抖被反复触发
        if (video.currentTime >= loopB || video.currentTime < loopA - 0.3) {
            video.currentTime = loopA;
        }
    }

    function maybeStartLoop() {
        if (loopA === null || loopB === null) return;
        if (loopB - loopA < 0.3) {
            console.warn('[Apeiria] B 必须比 A 晚至少 0.3 秒，循环未启动！');
            updateLoopUI();
            return;
        }
        const video = getMainVideo();
        if (!video) return;
        loopVideo = video;
        if (!loopActive) {
            loopActive = true;
            console.log('[Apeiria] A-B循环引擎点火！' + fmtTime(loopA) + ' ~ ' + fmtTime(loopB));
        }
        // 激活时如果播放头不在区间内，立刻拽回 A 让用户马上听到循环
        if (video.currentTime < loopA || video.currentTime > loopB) {
            video.currentTime = loopA;
        }
        updateLoopUI();
    }

    function clearLoop() {
        loopA = null;
        loopB = null;
        loopActive = false;
        loopVideo = null;
        updateLoopUI();
    }

    btnA.onclick = () => {
        const video = getMainVideo();
        if (!video) {
            console.warn('[Apeiria] 找不到视频元素，A 点设置失败！');
            return;
        }
        loopA = video.currentTime;
        if (loopB !== null && loopB <= loopA) loopB = null; // 区间被改坏，B 作废重设
        console.log('[Apeiria] A 点已锚定在 ' + fmtTime(loopA));
        updateLoopUI();
        maybeStartLoop();
    };

    btnB.onclick = () => {
        const video = getMainVideo();
        if (!video) {
            console.warn('[Apeiria] 找不到视频元素，B 点设置失败！');
            return;
        }
        loopB = video.currentTime;
        if (loopA !== null && loopB <= loopA) loopA = null; // 区间被改坏，A 作废重设
        console.log('[Apeiria] B 点已锚定在 ' + fmtTime(loopB));
        updateLoopUI();
        maybeStartLoop();
    };

    btnClear.onclick = () => {
        clearLoop();
        console.log('[Apeiria] A-B循环已清除，自由播放恢复！');
    };

    // timeupdate 是视频播放时浏览器周期触发的时间更新事件（约每秒4次），
    // 在 document 上用捕获监听可以兜住任意（包括事后替换的）video 元素；
    // 后台标签页里 requestAnimationFrame 会被冻结，所以用它做主驱动，另加 200ms 轮询兜底。
    document.addEventListener('timeupdate', loopCheck, { capture: true });
    setInterval(loopCheck, 200);

    // 4. 音量核心魔法：接管并重构前向传播图
    function hookAudio() {
        const video = document.querySelector('video');
        if (video && !video.dataset.apeiriaHooked) {
            try {
                if (!globalAudioCtx) {
                    globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    globalLimiter = createLimiter(globalAudioCtx);
                }
                const source = globalAudioCtx.createMediaElementSource(video);
                globalGainNode = globalAudioCtx.createGain();

                globalGainNode.gain.value = currentVolume;

                source.connect(globalGainNode);
                globalGainNode.connect(globalLimiter);

                video.dataset.apeiriaHooked = "true";
                console.log("[Apeiria] 叮咚！成功接管音频张量！✨");
            } catch (e) {
                console.warn("[Apeiria] 挂载节点时遇到阻力...", e);
            }
        }
    }

    // 5. 全局唤醒魔法 (解决无声Bug的核心！)
    function tryResumeContext() {
        if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
            globalAudioCtx.resume().then(() => {
                console.log("[Apeiria] 哔哔！检测到页面交互，音频计算图已全线贯通！Boom！");
            });
        }
    }

    // 在文档根节点埋下监听器，捕获任何点击或按键信号作为激活条件
    document.addEventListener('click', tryResumeContext, { capture: true });
    document.addEventListener('keydown', tryResumeContext, { capture: true });

    // 6. 音量 UI 交互事件
    let isCollapsed = false;

    toggleBtn.onclick = () => {
        isCollapsed = !isCollapsed;
        sliderWrapper.style.height = isCollapsed ? '0px' : '160px';
        hookAudio();
    };

    slider.oninput = (e) => {
        const db = parseFloat(e.target.value);
        currentVolume = dbToGain(db);
        updateVolumeLabel(db);

        if (globalGainNode) {
            // Smooth ramp (30 ms time constant) instead of a step change, avoids clicks while dragging
            globalGainNode.gain.setTargetAtTime(currentVolume, globalAudioCtx.currentTime, 0.03);
        }
        hookAudio();
    };

    // 7. 定时巡视守护
    setInterval(() => {
        hookAudio();
        // 顺便检查一下是否被意外挂起
        tryResumeContext();
    }, 2000);

    updateLoopUI();
})();
