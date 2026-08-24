/* 注入到每个 HTML 响应：碰到口令页就自动登录再回来。
   真正的测试逻辑在 demo 页自己的 bootstrap 里。 */
(function () {
  if (document.getElementById("f") && document.getElementById("p")) {
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "test1234" }),
    }).then((r) => {
      if (r.ok) location.replace("/");
      else document.title = "DEMO:login-failed-" + r.status;
    });
  }
})();
