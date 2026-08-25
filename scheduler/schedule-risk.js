function riskFromTimes(endTime, dueDate, shippingRequiredDate) {
  const end = new Date(endTime);
  const due = shippingRequiredDate ? new Date(shippingRequiredDate) : (dueDate ? new Date(dueDate) : null);
  if (Number.isNaN(end.getTime())) return { level:'unknown', label:'无法判断', hours:null };
  if (!due || Number.isNaN(due.getTime())) return { level:'undated', label:'无交期', hours:null };
  const hours = (due.getTime() - end.getTime()) / 3600000;
  if (hours < 0) return { level:'late', label:'预计延期', hours:Math.round(hours*10)/10 };
  if (hours <= 8) return { level:'tight', label:'紧张', hours:Math.round(hours*10)/10 };
  if (hours <= 24) return { level:'watch', label:'关注', hours:Math.round(hours*10)/10 };
  return { level:'normal', label:'正常', hours:Math.round(hours*10)/10 };
}
module.exports = { riskFromTimes };
