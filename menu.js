/* Tested Photoshop Tools selector; four features loaded on first selection. */
(function () {
  var picker = document.getElementById("picker");
  var menu = document.getElementById("dropdown");
  var label = document.getElementById("pickerName");
  var heading = document.getElementById("heading");
  var message = document.querySelector("#bodyArea > #message");
  var options = menu.querySelectorAll(".item");
  var loadedNineSlice = false;
  var loadedSpriteFont = false;
  var loadedRemoveBg = false;
  var loadedTextCutter = false;
  var loadedSmartArrange = false;
  var loadedVisibleResize = false;
  var loadedBoundsFrame = false;
  var bodyArea = document.getElementById("bodyArea");
  function setMenuOpen(open) {
    // Some UXP input controls render above CSS z-index layers. Hiding only
    // the content's visibility prevents them from covering the selector.
    // Visibility preserves DOM, input values, layout, and scroll position.
    bodyArea.style.visibility = open ? "hidden" : "visible";
    if (open) {
      // Use all available panel height; only scroll if the panel is truly too short.
      menu.style.maxHeight = Math.max(120, window.innerHeight - 62) + "px";
      menu.scrollTop = 0;
    }
    menu.style.display = open ? "block" : "none";
  }
  picker.addEventListener("click", function () {
    setMenuOpen(menu.style.display === "none");
  });
  for (var i = 0; i < options.length; i++) {
    options[i].addEventListener("click", function () {
      var name = this.getAttribute("data-name");
      var showNine = name === "九宫格拉伸";
      var showSprite = name === "图片数字排版";
      var showRemoveBg = name === "透明对象拆分";
      var showTextCutter = name === "文字批量切图";
      var showSmartArrange = name === "智能排列";
      var showVisibleResize = name === "批量尺寸统一";
      var showBoundsFrame = name === "边界框";
      label.textContent = name;
      heading.textContent = name;
      message.textContent = "此工具将在后续测试阶段接入。";
      for (var j = 0; j < options.length; j++) {
        options[j].className = options[j] === this ? "item selected" : "item";
        options[j].querySelector(".check").textContent = options[j] === this ? "✓" : "";
      }
      var nineView = document.getElementById("nineSliceView");
      var spriteView = document.getElementById("spriteFontView");
      var removeView = document.getElementById("removeBgView");
      var textView = document.getElementById("textCutterView");
      var smartView = document.getElementById("smartArrangeView");
      var resizeView = document.getElementById("visibleResizeView");
      var frameView = document.getElementById("boundsFrameView");
      nineView.style.display = showNine ? "block" : "none";
      spriteView.style.display = showSprite ? "block" : "none";
      removeView.style.display = showRemoveBg ? "block" : "none";
      textView.style.display = showTextCutter ? "block" : "none";
      smartView.style.display = showSmartArrange ? "block" : "none";
      resizeView.style.display = showVisibleResize ? "block" : "none";
      frameView.style.display = showBoundsFrame ? "block" : "none";
      var showFallback = !showNine && !showSprite && !showRemoveBg && !showTextCutter && !showSmartArrange && !showVisibleResize && !showBoundsFrame;
      heading.style.display = showFallback ? "block" : "none";
      message.style.display = showFallback ? "block" : "none";
      document.querySelector(".spacer").style.display = showFallback ? "block" : "none";
      document.getElementById("bottomText").style.display = showFallback ? "block" : "none";
      var area = document.getElementById("bodyArea");
      if (showNine) area.classList.add("nine-active");
      else area.classList.remove("nine-active");
      setMenuOpen(false);

      if (showNine && !loadedNineSlice) {
        try {
          require("./nine-slice.js")(nineView);
          loadedNineSlice = true;
        } catch (error) {
          console.error("[Photoshop Tools] Nine Slice failed:", error);
          nineView.style.display = "none";
          area.classList.remove("nine-active");
          heading.style.display = "block";
          message.style.display = "block";
          heading.textContent = "九宫格工具启动失败";
          message.textContent = String(error && error.message || error);
        }
      }
      if (showNine && loadedNineSlice && typeof nineView.__nineSliceActivate === 'function') {
        nineView.__nineSliceActivate();
      }
      if (showSprite && !loadedSpriteFont) {
        try {
          require("./sprite-font.js")(spriteView);
          loadedSpriteFont = true;
        } catch (error) {
          console.error("[Photoshop Tools] Sprite Font failed:", error);
          spriteView.style.display = "none";
          heading.style.display = "block";
          message.style.display = "block";
          heading.textContent = "图片数字排版工具启动失败";
          message.textContent = String(error && error.message || error);
        }
      }
      if (showRemoveBg && !loadedRemoveBg) {
        try {
          require("./remove-bg.js")(removeView);
          loadedRemoveBg = true;
        } catch (error) {
          console.error("[Photoshop Tools] Transparent Split failed:", error);
          removeView.style.display = "none";
          heading.style.display = "block";
          message.style.display = "block";
          heading.textContent = "透明对象拆分工具启动失败";
          message.textContent = String(error && error.message || error);
        }
      }
      if(showRemoveBg && loadedRemoveBg && typeof removeView.__transparentSplitActivate==='function'){
        removeView.__transparentSplitActivate();
      }
      if (showTextCutter && !loadedTextCutter) {
        try {
          require("./text-cutter.js")(textView);
          loadedTextCutter = true;
        } catch (error) {
          console.error("[Photoshop Tools] Text Cutter failed:", error);
          textView.style.display = "none";
          heading.style.display = "block";
          message.style.display = "block";
          heading.textContent = "文字批量切图工具启动失败";
          message.textContent = String(error && error.message || error);
        }
      }
      if(showTextCutter && loadedTextCutter && typeof textView.__textCutterActivate==="function"){
        textView.__textCutterActivate();
      }
      if (showSmartArrange && !loadedSmartArrange) {
        try {
          require("./smart-arrange.js")(smartView);
          loadedSmartArrange = true;
        } catch (error) {
          console.error("[Photoshop Tools] Smart Arrange failed:", error);
          smartView.style.display = "none";
          heading.style.display = "block";
          message.style.display = "block";
          heading.textContent = "智能排列工具启动失败";
          message.textContent = String(error && error.message || error);
        }
      } else if (showSmartArrange && loadedSmartArrange && typeof smartView.__smartArrangeActivate === "function") {
        smartView.__smartArrangeActivate();
      }
      if (showBoundsFrame && !loadedBoundsFrame) {
        try {
          require("./bounds-frame.js")(frameView);
          loadedBoundsFrame = true;
        } catch (error) {
          console.error("[Photoshop Tools] Bounds Frame failed:", error);
          frameView.style.display = "none";
          heading.style.display = "block";
          message.style.display = "block";
          heading.textContent = "边界框工具启动失败";
          message.textContent = String(error && error.message || error);
        }
      } else if (showBoundsFrame && loadedBoundsFrame && typeof frameView.__boundsFrameActivate === "function") {
        frameView.__boundsFrameActivate();
      }
      if (showVisibleResize && !loadedVisibleResize) {
        try {
          require("./visible-resize.js")(resizeView);
          loadedVisibleResize = true;
        } catch (error) {
          console.error("[Photoshop Tools] Batch Visible Resize failed:", error);
          resizeView.style.display = "none";
          heading.style.display = "block";
          message.style.display = "block";
          heading.textContent = "批量尺寸统一启动失败";
          message.textContent = String(error && error.message || error);
        }
      } else if (showVisibleResize && loadedVisibleResize && typeof resizeView.__visibleResizeActivate === "function") {
        resizeView.__visibleResizeActivate();
      }
    });
  }
}());
