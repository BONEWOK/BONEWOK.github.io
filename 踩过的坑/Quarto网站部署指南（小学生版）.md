# 小学生也能学会的Quarto网站部署指南 📚✨

> 想拥有一个自己的网站吗？只要跟着下面的步骤，就像搭积木一样简单！

## 第一步：我们需要什么？🧰

- 一台电脑（Windows/Mac都可以）
- 安装了 **Quarto**（一个帮你做网站的工具）
- 一个 **GitHub** 账号（网站的家）

> 💡 如果还没有安装Quarto，可以请爸爸妈妈帮你从 [quarto.org](https://quarto.org) 下载安装。GitHub账号也需要大人帮忙注册哦。

---

## 第二步：在电脑上建一个网站文件夹 📁

1. 在桌面新建一个文件夹，取名叫 `my-website`。
2. 打开这个文件夹，在里面放一个叫 `index.qmd` 的文件（这是你网站的第一页）。
3. 用记事本打开 `index.qmd`，写上：
   ```
   ---
   title: "我的第一个网站"
   ---

   你好，世界！这是我的网站。
   ```
4. 保存文件。

---

## 第三步：让网站变成漂亮的HTML页面 🎨

1. 打开电脑的“命令提示符”或“终端”（可以在开始菜单搜索“cmd”或“终端”打开）。
2. 输入下面的命令，按回车，进入你的网站文件夹：
   ```
   cd 桌面\my-website
   ```
3. 输入下面的命令，按回车，让Quarto帮你把网站“变”出来：
   ```
   quarto preview
   ```
   这时候你的浏览器会自动打开，可以看到你的网站长什么样啦！😊  
   按 `Ctrl+C` 可以关闭预览。

---

## 第四步：把网站放到GitHub上（第一次搬家）🚚

1. 打开 [github.com](https://github.com)，登录你的账号。
2. 点绿色的 **New** 按钮，新建一个仓库（repository）。
   - Repository name 填：`你的用户名.github.io`（比如你的用户名是 `xiaoming`，就填 `xiaoming.github.io`）
   - 保持公开（Public），不要勾选任何初始化选项。
   - 点 **Create repository**。
3. 回到电脑的命令行，输入下面这些命令，一行一行敲，每敲完一行按一次回车：
   ```
   git init
   git add .
   git commit -m "第一次提交"
   git branch -M main
   git remote add origin https://github.com/你的用户名/你的用户名.github.io.git
   ```
   ⚠️ 把命令里的 `你的用户名` 换成你自己的GitHub用户名。

4. 现在，用Quarto把网站“推”到GitHub上：
   ```
   quarto publish gh-pages
   ```
   它会问你要发布到哪个仓库，输入 `origin` 然后回车。  
   等它跑完，你的网站就上线啦！🎉

5. 去GitHub上检查：打开你的仓库，点 **Settings** → **Pages**，确保 **Branch** 选的是 `gh-pages`。  
   过几分钟，访问 `https://你的用户名.github.io` 就能看到你的网站了。

---

## 第五步：让网站自己更新（配置自动小助手🤖）

每次更新网站都要手动运行 `quarto publish` 有点麻烦，我们来请一个“小机器人”帮忙，以后只要把修改过的文件推上去，网站就会自动更新。

1. 在 `my-website` 文件夹里，新建一个文件夹叫 `.github`，再在里面新建一个文件夹叫 `workflows`。
2. 在 `workflows` 文件夹里新建一个文件叫 `publish.yml`，用记事本打开，把下面的内容复制进去：
   ```yaml
   on:
     push:
       branches: main

   name: Quarto Publish

   jobs:
     build-deploy:
       runs-on: ubuntu-latest
       permissions:
         contents: write
       steps:
         - name: Check out repository
           uses: actions/checkout@v4

         - name: Set up Quarto
           uses: quarto-dev/quarto-actions/setup@v2

         - name: Render and Publish
           uses: quarto-dev/quarto-actions/publish@v2
           with:
             target: gh-pages
           env:
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```
   保存文件。

3. 在命令行里输入：
   ```
   git add .
   git commit -m "添加自动更新小助手"
   git push
   ```
   第一次推送时，可能会提示你设置上游分支，输入：
   ```
   git push --set-upstream origin main
   ```

好了！现在小机器人已经在GitHub上等着了。以后你只要修改 `index.qmd`，然后执行这三行命令：
```
git add .
git commit -m "更新了网站内容"
git push
```
等一两分钟，你的网站就会自动更新啦！🌟

---

## 日常更新（就像写日记一样简单）📝

1. 打开 `my-website` 文件夹，修改或新建 `.qmd` 文件（比如 `diary.qmd`）。
2. 在文件里写你的内容。
3. 打开命令行，进入 `my-website` 文件夹。
4. 依次输入：
   ```
   git add .
   git commit -m "写了今天的日记"
   git push
   ```
5. 等一会儿，去你的网站看看，新内容已经出现啦！

---

## 可能遇到的问题（别怕，有办法）🆘

- **命令敲错了怎么办？**  
  没关系，重新敲一遍正确的就行。或者按方向键↑可以调出上一条命令修改。

- **提示“不是git仓库”**  
  说明你忘记 `git init` 了，在 `my-website` 文件夹里执行一下就好。

- **push时要求输入用户名密码**  
  GitHub现在不能用密码了，需要用token。让大人帮忙生成一个token（Settings → Developer settings → Personal access tokens），复制后粘贴到密码框里（粘贴时屏幕不会显示，直接回车就行）。

- **网站更新后没变化？**  
  等几分钟，或者去GitHub仓库的 **Actions** 标签页看看小机器人有没有成功运行。如果有红色叉叉，点进去看日志，把错误信息复制给大人帮忙看看。

---

## 总结一下，我们学会了什么？✅

- 用Quarto制作简单的网站
- 把网站存到GitHub上
- 请小机器人（GitHub Actions）自动更新网站
- 以后只要写内容、敲三行命令，网站就自动更新

现在，你可以拥有一个属于自己的网站啦！快去试试吧！🎈

> 如果还有不懂的地方，可以问问爸爸妈妈，或者在网上搜索“Quarto GitHub Pages”找更多教程。