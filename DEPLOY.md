# 模切 APS V5.1 部署说明

## 安装
npm install

## 启动
NODE_ENV=production node server.js

访问：http://localhost:3000

## V5.1 排程规则
1. 有有效交货/出货需求日期的订单，优先于无交期订单。
2. 有交期订单内部按交期从近到远，再使用 V5 多目标评分。
3. 无交期订单统一后置。
4. 正在生产的订单继续保持锁定，不参与自动重排。

正式环境升级前请备份 data.db；数据库不提交到 GitHub。
