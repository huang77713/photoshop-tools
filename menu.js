/* Tested Photoshop Tools selector; only two feature modules are active. */
(function () {
  var picker = document.getElementById("picker");
  var menu = document.getElementById("dropdown");
  var label = document.getElementById("pickerName");
  var heading = document.getElementById("heading");
  var message = document.getElementById("message");
  var options = menu.querySelectorAll(".item");
  var loadedNineSlice = false;
  var loadedSpriteFont = false;
  var bodyArea = document.getElementById("bodyArea");
  function setMenuOpen(open) {
    // Some UXP input controls render above CSS z-index layers. Hiding only
    // the content's visibility prevents them from covering the selector.
    // Visibility preserves DOM, input values, layout, and scroll position.
    bodyArea.style.visibility = open ? "hidden" : "visible";
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
      label.textContent = name;
      heading.textContent = name;
      message.textContent = "此工具将在后续测试阶段接入。";
      for (var j = 0; j < options.length; j++) {
        options[j].className = options[j] === this ? "item selected" : "item";
        options[j].querySelector(".check").textContent = options[j] === this ? "✓" : "";
      }
      var nineView = document.getElementById("nineSliceView");
      var spriteView = document.getElementById("spriteFontView");
      nineView.style.display = showNine ? "block" : "none";
      spriteView.style.display = showSprite ? "block" : "none";
      var showFallback = !showNine && !showSprite;
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
    });
  }
}());
