/**
 * 锅巴（Guoba）插件配置面板的 schema。
 *
 * 每个 component: 'SOFT_GROUP_BEGIN' 的 label 会成为面板上的一个标签页，
 * 其余字段按顺序渲染到该标签页里。
 */
import Cfg from './model/Cfg.js'
import Prompt from './model/Prompt.js'
import path from 'node:path'
import { pluginResources } from './config/constant.js'

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'DeepChat-plugin',
      title: 'DeepChat-plugin',
      author: 'FeatherCloudSky',
      authorLink: 'https://github.com/FeatherCloudSky',
      link: 'https://github.com/FeatherCloudSky/DeepChat-plugin',
      isV3: true,
      isV2: false,
      description: '接入 OpenAI / Anthropic 兼容 API 的拟人聊天插件 · MIT 开源，使用前请阅读免责声明',
      icon: 'mdi:robot-happy-outline',
      iconColor: '#5b8def',
      // 面板里优先显示这张图（锅巴会把 iconPath 指向的文件直接当图片发过来）；
      // 上面那个 icon 只是它加载不到图片时的兜底，别删。
      // 图是插件自带的原创素材，用 work/make-icon.py 从同目录的 icon.svg 生成。
      iconPath: path.join(pluginResources, 'images', 'icon.png')
    },

    configInfo: {
      schemas: [
        // ---------------------------------------------------------- API 配置
        { label: 'API 配置', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'useAnthropic',
          label: '使用 Anthropic 协议',
          bottomHelpMessage: '服务商给的接口是 /messages 就打开；是 /chat/completions 就关闭',
          component: 'Switch'
        },
        {
          field: 'apiUrl',
          label: 'API 地址',
          bottomHelpMessage: '基础地址，不带 /chat/completions 或 /messages（填了也认）。DeepSeek 官方文档给的是 https://api.deepseek.com，没有 /v1；留空则用所选协议的官方地址',
          component: 'Input',
          componentProps: { placeholder: 'https://api.deepseek.com' }
        },
        {
          field: 'apiKey',
          label: 'API Key',
          bottomHelpMessage: '支持多个 Key，用逗号分隔，每次请求随机取一个（可用于轮询额度）',
          component: 'InputPassword',
          componentProps: { placeholder: 'sk-******' }
        },
        {
          field: 'model',
          label: '模型名称',
          bottomHelpMessage: '要调用的模型，例如 deepseek-chat、gpt-4o、claude-3-5-sonnet-latest',
          component: 'Input',
          componentProps: { placeholder: 'deepseek-chat' }
        },
        {
          field: 'anthropicVersion',
          label: 'Anthropic 版本号',
          bottomHelpMessage: '仅 Anthropic 协议使用，作为 anthropic-version 请求头',
          component: 'Input',
          componentProps: { placeholder: '2023-06-01' }
        },
        {
          field: 'attemptMax',
          label: '重试次数',
          bottomHelpMessage: '调用失败时最多重试几次（含首次）',
          component: 'InputNumber',
          componentProps: { min: 1, max: 10, step: 1, placeholder: '2' }
        },
        {
          field: 'timeoutMs',
          label: '请求超时（毫秒）',
          bottomHelpMessage: '超过这个时间未返回就中断本次请求',
          component: 'InputNumber',
          componentProps: { min: 1000, max: 600000, step: 1000, placeholder: '60000' }
        },

        // ---------------------------------------------------------- 模型能力
        { label: '模型能力', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'defaultVision',
          label: '默认支持图片输入',
          bottomHelpMessage: '没有在下面的列表里单独声明的模型，一律按这个开关处理',
          component: 'Switch'
        },
        {
          field: 'modelVision',
          label: '逐模型图片能力',
          bottomHelpMessage: '精确匹配模型名；模型名填 * 表示兜底规则。决定发送图片时用多模态还是退化成 [图片] 文字',
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            schemas: [
              {
                field: 'key',
                label: '模型名',
                component: 'Input',
                required: true,
                componentProps: { placeholder: 'gpt-4o 或 *' }
              },
              {
                field: 'vision',
                label: '支持图片输入',
                component: 'Switch'
              }
            ]
          }
        },
        {
          field: 'imageMaxCount',
          label: '单条消息最多图片数',
          bottomHelpMessage: '一次最多把几张图片发给模型，设为 0 表示完全不发图片',
          component: 'InputNumber',
          componentProps: { min: 0, max: 10, step: 1, placeholder: '3' }
        },
        {
          field: 'imageDownload',
          label: '下载图片后以 base64 发送',
          bottomHelpMessage: '强烈建议开启。不开时是把 QQ 的图片链接直接交给服务商，让它自己下载——而 QQ 图片是带鉴权、有时效的临时地址，服务商多半拉不到，症状就是「模型看不到图」。开启后由插件先下载再以 base64 内联发送，最可靠',
          component: 'Switch'
        },
        {
          field: 'imageDetail',
          label: '图片细节级别',
          bottomHelpMessage: '传给服务商的 image_url.detail。low = 先缩到 512×512 再推理，更快更省 token；original / high = 保留原图；auto = 由服务商决定。留空则不发送这个字段（不是所有兼容服务商都认它，留空最保险）',
          component: 'Select',
          componentProps: {
            options: [
              { label: '不发送（最保险）', value: '' },
              { label: 'low — 缩到 512×512，省 token', value: 'low' },
              { label: 'original — 保留原图', value: 'original' },
              { label: 'high — 保留原图（兼容写法）', value: 'high' },
              { label: 'auto — 由服务商决定', value: 'auto' }
            ]
          }
        },
        {
          field: 'imageHistoryMark',
          label: '历史记录里的图片占位符',
          bottomHelpMessage: '缓存上下文时图片会被替换成这个文字，避免 base64 撑爆缓存',
          component: 'Input',
          componentProps: { placeholder: '[图片]' }
        },

        // ---------------------------------------------------------- 基本配置
        { label: '基本配置', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'prompt',
          label: 'Prompt 人设',
          bottomHelpMessage: '系统提示词，定义 AI 的身份与说话风格',
          component: 'InputTextArea',
          componentProps: { rows: 6, placeholder: '你是一只可爱的猫娘……' }
        },
        {
          field: 'promptIndex',
          label: '人设（一套一个文件）',
          bottomHelpMessage: '每个条目对应 data/prompts/ 里的一个人设文件：改「显示名」即改名，' +
            '填「内容」即覆盖文件内容，删掉整行即删掉这个人设。' +
            '**内容留空 = 保留文件里原有的**（长人设就别往这里贴了，面板保存的请求体上限只有 100KB，' +
            '超了会被服务器 413 拒掉）—— 长文用「#设置人设 名字」+ 引用一条消息来存。' +
            '切换命令：#切换提示词1 / #切换提示词 名字 / #切换提示词0（回默认人设）',
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            schemas: [
              {
                field: 'key',
                label: '文件名',
                component: 'Input',
                bottomHelpMessage: '人设文件名（不含 .json），插件自动填，一般不用动',
                componentProps: { placeholder: '猫娘' }
              },
              {
                field: 'title',
                label: '显示名',
                component: 'Input',
                required: true,
                componentProps: { placeholder: '猫娘 / 严肃助手 / 猫粮推销员……' }
              },
              {
                field: 'content',
                label: '内容（留空=不改）',
                component: 'InputTextArea',
                bottomHelpMessage: '只有想替换这个人设的内容时才填；留空表示保持文件里原有的不变',
                componentProps: { rows: 4, placeholder: '留空即可；要改长文请用 #设置人设 名字 + 引用' }
              }
            ]
          }
        },
        {
          field: 'aiName',
          label: 'AI 名称',
          bottomHelpMessage: '消息里任意位置出现这个词就触发回复，不需要 @。例如填「达达利亚」，「不知道达达利亚圣遗物带什么好」也会触发',
          component: 'Input',
          componentProps: { placeholder: '猫娘' }
        },
        {
          field: 'aiNameRegex',
          label: '把 AI 名称当作正则',
          bottomHelpMessage: '默认关闭＝按关键词包含匹配。名称里含 . * + ? 这类符号、或想用「A|B」一次匹配多个名字时再打开',
          component: 'Switch'
        },
        {
          field: 'enableName',
          label: '名字触发回复',
          bottomHelpMessage: '关闭后，即使消息里出现 AI 名称也不会触发。名称与关键词都算明确呼叫，走主动模式：用主动温度 / token 上限，且不受伪人黑白名单限制',
          component: 'Switch'
        },
        {
          field: 'aiKeywords',
          label: '触发关键词',
          bottomHelpMessage: '至多 20 个，消息里出现任意一个就触发主动回复；纯字面匹配、不当正则。适合放 AI 的别名，例如「小助手、机器人」',
          component: 'GTags',
          componentProps: {
            allowAdd: true,
            allowDel: true
          }
        },
        {
          field: 'enableAt',
          label: '被艾特时回复',
          bottomHelpMessage: '群聊里艾特机器人时是否回复',
          component: 'Switch'
        },
        {
          field: 'enablePrivate',
          label: '允许私聊使用',
          bottomHelpMessage: '总开关。关闭后私聊一律不响应，且 #chat开 也无法绕过',
          component: 'Switch'
        },
        {
          field: 'thinking',
          label: '先回「正在思考中」',
          bottomHelpMessage: '需要等待时先发一条提示，30 秒后自动撤回',
          component: 'Switch'
        },
        {
          field: 'temperature',
          label: '温度',
          bottomHelpMessage: '主动回复的随机性，越低越稳定（0 ~ 2）',
          component: 'InputNumber',
          componentProps: { min: 0, max: 2, step: 0.1, placeholder: '1' }
        },
        {
          field: 'maxTokens',
          label: '回复 token 上限',
          bottomHelpMessage: '主动回复最多生成多少 token',
          component: 'InputNumber',
          componentProps: { min: 16, max: 65536, step: 1, placeholder: '512' }
        },

        // ---------------------------------------------------------- 分条发送
        { label: '分条发送', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'splitReply',
          label: '按句号/问号拆条发送',
          bottomHelpMessage: '开启后，一段回复会按。？！和换行拆成多条依次发出，更像真人打字',
          component: 'Switch'
        },
        {
          field: 'maxSplitSegments',
          label: '最多拆成几条',
          bottomHelpMessage: '超过这个条数就整段发送，避免刷屏',
          component: 'InputNumber',
          componentProps: { min: 1, max: 50, step: 1, placeholder: '5' }
        },
        {
          field: 'noSplitOverLength',
          label: '超过多少字数不拆',
          bottomHelpMessage: '回复长度达到这个字符数就整段发送',
          component: 'InputNumber',
          componentProps: { min: 50, max: 100000, step: 50, placeholder: '500' }
        },
        {
          field: 'replyDelayPerChar',
          label: '每条回复后的延迟（毫秒/字）',
          bottomHelpMessage: '模拟打字节奏，0 表示不延迟',
          component: 'InputNumber',
          componentProps: { min: 0, max: 5000, step: 10, placeholder: '150' }
        },
        {
          field: 'replyDelayMaxMs',
          label: '单条延迟上限（毫秒）',
          bottomHelpMessage: '防止长句等待过久',
          component: 'InputNumber',
          componentProps: { min: 0, max: 60000, step: 100, placeholder: '2000' }
        },

        // ---------------------------------------------------------- 上下文与缓存
        { label: '上下文与缓存', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'historyCount',
          label: '附加聊天记录条数',
          bottomHelpMessage: '首次对话时，额外带上最近多少条群聊/私聊记录作为语感参考（0 ~ 50）',
          component: 'InputNumber',
          componentProps: { min: 0, max: 50, step: 1, placeholder: '7' }
        },
        {
          field: 'maxContextLength',
          label: '最大上下文长度',
          bottomHelpMessage: '缓存里最多保留多少条对话消息（1 ~ 200）',
          component: 'InputNumber',
          componentProps: { min: 1, max: 200, step: 1, placeholder: '25' }
        },
        {
          field: 'cacheExpireMinutes',
          label: '缓存过期时间（分钟）',
          bottomHelpMessage: '超过这个时间没有新消息，本会话的上下文会被清空',
          component: 'InputNumber',
          componentProps: { min: 1, max: 10080, step: 1, placeholder: '60' }
        },

        // ---------------------------------------------------------- 启用控制
        { label: '启用控制', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'enableByDefault',
          label: '默认启用 AI',
          bottomHelpMessage: '没有出现在下面任何列表里的会话，按这个开关决定',
          component: 'Switch'
        },
        {
          field: 'enabledGroups',
          label: '强制启用的群',
          bottomHelpMessage: '这些群一定启用，优先于「默认启用」',
          component: 'GSelectGroup'
        },
        {
          field: 'disabledGroups',
          label: '强制停用的群',
          bottomHelpMessage: '这些群一定停用，优先级最高',
          component: 'GSelectGroup'
        },
        {
          field: 'enabledUsers',
          label: '强制启用的私聊用户',
          bottomHelpMessage: '这些 QQ 号私聊时一定启用（仍需「允许私聊使用」为开）',
          component: 'GTags',
          componentProps: {
            allowAdd: true,
            allowDel: true,
            valueFormatter: ((value) => Number.parseInt(value)).toString()
          }
        },
        {
          field: 'disabledUsers',
          label: '强制停用的私聊用户',
          bottomHelpMessage: '这些 QQ 号私聊时一定停用，优先级最高',
          component: 'GTags',
          componentProps: {
            allowAdd: true,
            allowDel: true,
            valueFormatter: ((value) => Number.parseInt(value)).toString()
          }
        },

        // ---------------------------------------------------------- 权限设置
        { label: '权限设置', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'masterQQ',
          label: '主人 QQ',
          bottomHelpMessage: '只能填一个。留空则沿用 Yunzai 自身的 isMaster；填了之后，Yunzai 的主人依然保留主人权限',
          component: 'Input',
          componentProps: { placeholder: '例如 10001' }
        },
        {
          field: 'adminQQ',
          label: '管理员 QQ',
          bottomHelpMessage: '最多 5 个，超出部分会被忽略并写进日志。管理员可以开关会话、重置会话设置',
          component: 'GTags',
          componentProps: {
            allowAdd: true,
            allowDel: true,
            valueFormatter: ((value) => Number.parseInt(value)).toString()
          }
        },
        {
          field: 'allowMemberToggle',
          label: '允许普通成员开关会话',
          bottomHelpMessage: '关闭时，只有主人和管理员能执行 #chat开 / #chat关 / #chat重置',
          component: 'Switch'
        },

        // ---------------------------------------------------------- 聊天记录
        { label: '聊天记录', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'recordOutput',
          label: '记录发送方式',
          bottomHelpMessage: '发 #结束记录 时怎么把记录给你们。合并转发是 QQ 原生的「聊天记录」卡片，最体面；auto = 依次尝试 合并转发 → md 文件 → 纯文本',
          component: 'Select',
          componentProps: {
            options: [
              { label: 'auto — 依次降级（推荐）', value: 'auto' },
              { label: '合并转发 — 聊天记录卡片', value: 'forward' },
              { label: 'md 文件 — 发 Markdown', value: 'file' },
              { label: '纯文本 — 直接发文字', value: 'text' }
            ]
          }
        },
        {
          field: 'recordMaxMessages',
          label: '单次记录上限（条）',
          bottomHelpMessage: '超过就不再记录，避免刷屏的群把磁盘写爆；发 #记录状态 可以看到当前条数',
          component: 'InputNumber',
          componentProps: { min: 10, max: 100000, step: 10, placeholder: '2000' }
        },
        {
          field: 'recordIncludeBot',
          label: '记录机器人自己的发言',
          bottomHelpMessage: '默认不记。开启后 AI 的回复也会进记录',
          component: 'Switch'
        },
        {
          field: 'recordExpireHours',
          label: '未结束的记录保留时长（小时）',
          bottomHelpMessage: '开了记录却一直没发 #结束记录 的，超过这个时间会被自动清理',
          component: 'InputNumber',
          componentProps: { min: 1, max: 720, step: 1, placeholder: '24' }
        },
        {
          field: 'allowMemberRecord',
          label: '允许普通成员使用聊天记录',
          bottomHelpMessage: '默认关。开启后，普通成员也能发 #记录 把群里所有人的发言打包发出来——' +
            '这是隐私敏感操作，建议用下面两个群列表按群放开，而不是全局开',
          component: 'Switch'
        },
        {
          field: 'memberRecordAllowGroups',
          label: '允许成员记录的群',
          bottomHelpMessage: '这些群强制放开给普通成员，即使「允许成员使用」总开关是关的也放行（和「启用控制」里' +
            '的启用列表同一个逻辑）。优先级低于下面的禁止列表',
          component: 'GSelectGroup'
        },
        {
          field: 'memberRecordDenyGroups',
          label: '禁止成员记录的群',
          bottomHelpMessage: '这些群里一律只有主人和管理员能记录，优先级最高——' +
            '即使「允许成员使用」开着、也在允许列表里，这里照样拦下',
          component: 'GSelectGroup'
        },

        // ---------------------------------------------------------- 海龟汤
        { label: '海龟汤', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'soupEnable',
          label: '启用汤面功能',
          bottomHelpMessage: '关闭后 #汤面 和 #删除汤面 都不再响应（已记下的汤面会留到过期）',
          component: 'Switch'
        },
        {
          field: 'soupExpireHours',
          label: '汤面保存时长（小时）',
          bottomHelpMessage: '默认 24。到点自动删除；期间发 #汤面 可以随时再看',
          component: 'InputNumber',
          componentProps: { min: 1, max: 720 }
        },
        {
          field: 'soupMaxImages',
          label: '汤面最多保存几张图',
          bottomHelpMessage: '默认 3，填 0 表示只收文字。图片会下载到插件的 data/soup/ 里存着' +
            '（QQ 的图片地址过一阵就失效，只存链接放不到一天），过期或删除时自动清掉',
          component: 'InputNumber',
          componentProps: { min: 0, max: 9 }
        },
        {
          field: 'soupMaxImageSide',
          label: '汤面图片单边像素上限',
          bottomHelpMessage: '默认 10000，也就是 10000×10000。超过的图会自动缩小后再存 —— ' +
            '缩放借宿主自带的渲染器（出帮助图那个）完成，插件本身不装任何东西',
          component: 'InputNumber',
          componentProps: { min: 100, max: 50000 }
        },
        {
          field: 'soupMaxImageMB',
          label: '汤面单张图片体积上限（MB）',
          bottomHelpMessage: '默认 20。存之前按像素和体积两个上限检查，超了先自动缩小；' +
            '实在缩不动才跳过，并在回复里说明原因',
          component: 'InputNumber',
          componentProps: { min: 1, max: 256 }
        },
        {
          field: 'soupRefreshOnView',
          label: '查看时重新计时',
          bottomHelpMessage: '关闭（默认）：从记录那一刻起算，满「保存时长」就过期。' +
            '打开：每次发 #汤面 都把过期时间往后顺延一次',
          component: 'Switch'
        },
        {
          field: 'soupAllowMember',
          label: '允许普通成员使用',
          bottomHelpMessage: '默认开。汤面属于会话，不是发汤面那个人的私产——谁引用它都能记、都能删。' +
            '关掉后只有主人 / 管理员能记录和删除，查看不受影响',
          component: 'Switch'
        },

        // ---------------------------------------------------------- 群发消息
        { label: '群发消息', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'broadcastGroups',
          label: '要群发的群',
          bottomHelpMessage: '选好群、填好内容后，在任意会话发 #群发 才会真正发出去。面板本身不会自动发——群发是这类插件里最容易让账号被风控的动作，得你明确扣一次扳机',
          component: 'GSelectGroup'
        },
        {
          field: 'broadcastContent',
          label: '群发内容',
          bottomHelpMessage: '要统一发出去的文字',
          component: 'InputTextArea',
          componentProps: { rows: 5, placeholder: '要发的内容…' }
        },
        {
          field: 'broadcastDelayMinutes',
          label: '延迟发送（分钟）',
          bottomHelpMessage: '发 #群发 之后等多少分钟开始发；0 表示立刻开始',
          component: 'InputNumber',
          componentProps: { min: 0, max: 1440, step: 1, placeholder: '1' }
        },
        {
          field: 'broadcastGapSeconds',
          label: '群与群之间的随机间隔（秒）',
          bottomHelpMessage: '格式：下限-上限，例如 10-60。每条之间随机等这么久，避免被风控当成机器扫射',
          component: 'Input',
          componentProps: { placeholder: '10-60' }
        },
        {
          field: 'broadcastMaxGroups',
          label: '单次群发群数上限',
          bottomHelpMessage: '超过就拒绝执行，防止手滑选中一堆群',
          component: 'InputNumber',
          componentProps: { min: 1, max: 100, step: 1, placeholder: '20' }
        },

        // ---------------------------------------------------------- 伪人模式
        { label: '伪人模式', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'enablePseudoHuman',
          label: '启用伪人模式',
          bottomHelpMessage: '开启后 AI 会按概率主动接群友的话，而不是只被动回答',
          component: 'Switch'
        },
        {
          field: 'pseudoHumanProbability',
          label: '触发概率（%）',
          bottomHelpMessage: '每条群消息被接话的概率，建议 1 ~ 5，太高会很吵',
          component: 'InputNumber',
          componentProps: { min: 0, max: 100, step: 1, placeholder: '3' }
        },
        {
          field: 'pseudoTemperature',
          label: '伪人模式温度',
          bottomHelpMessage: '伪人回复的随机性，通常比主动模式更高',
          component: 'InputNumber',
          componentProps: { min: 0, max: 2, step: 0.1, placeholder: '1.5' }
        },
        {
          field: 'pseudoMaxTokens',
          label: '伪人模式 token 上限',
          bottomHelpMessage: '伪人回复要短，建议 64 ~ 256',
          component: 'InputNumber',
          componentProps: { min: 8, max: 4096, step: 1, placeholder: '128' }
        },
        {
          field: 'delay',
          label: '伪人随机延迟（毫秒）',
          bottomHelpMessage: '格式：下限-上限，例如 500-3000；留空则不延迟',
          component: 'Input',
          componentProps: { placeholder: '500-3000' }
        },

        // ---------------------------------------------------------- 黑白名单
        { label: '黑白名单设置', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'pseudoWhitelistGroups',
          label: '伪人群白名单',
          bottomHelpMessage: '只在这些群启用伪人接话，留空表示不限制',
          component: 'GSelectGroup'
        },
        {
          field: 'pseudoBlacklistGroups',
          label: '伪人群黑名单',
          bottomHelpMessage: '这些群不参与伪人接话（白名单优先）',
          component: 'GSelectGroup'
        },
        {
          field: 'pseudoWhitelistUsers',
          label: '伪人用户白名单',
          bottomHelpMessage: '只有这些 QQ 号说的话会被接，留空表示不限制',
          component: 'GTags',
          componentProps: {
            allowAdd: true,
            allowDel: true,
            valueFormatter: ((value) => Number.parseInt(value)).toString()
          }
        },
        {
          field: 'pseudoBlacklistUsers',
          label: '伪人用户黑名单',
          bottomHelpMessage: '这些 QQ 号说的话不会被接（白名单优先）',
          component: 'GTags',
          componentProps: {
            allowAdd: true,
            allowDel: true,
            valueFormatter: ((value) => Number.parseInt(value)).toString()
          }
        },

        // ---------------------------------------------------------- 帮助图
        { label: '帮助图', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'helpBg',
          label: '帮助背景',
          bottomHelpMessage: '留空使用插件自带背景；可填本地图片路径、http(s) 链接或 file:// 地址。相对路径按 Yunzai 根目录解析',
          component: 'Input',
          componentProps: { placeholder: '留空 = 用自带的默认背景' }
        },
        {
          field: 'helpBgMask',
          label: '背景暗化程度',
          bottomHelpMessage: '背景上压一层黑色遮罩，数值越大文字越清楚（0 ~ 95）',
          component: 'InputNumber',
          componentProps: { min: 0, max: 95, step: 5, placeholder: '45' }
        },
        {
          field: 'helpBgBlur',
          label: '背景模糊（px）',
          bottomHelpMessage: '把背景糊掉，让文字更易读；0 表示不模糊',
          component: 'InputNumber',
          componentProps: { min: 0, max: 30, step: 1, placeholder: '6' }
        },
        {
          field: 'helpAccent',
          label: '帮助图强调色',
          bottomHelpMessage: '标题、分组名和左侧竖条的颜色，十六进制色值',
          component: 'Input',
          componentProps: { placeholder: '#ffd9a0' }
        },
        {
          field: 'helpTitle',
          label: '帮助图标题',
          bottomHelpMessage: '留空则使用 help.md 里的一级标题',
          component: 'Input',
          componentProps: { placeholder: 'DeepChat 帮助' }
        },
        {
          field: 'helpSubTitle',
          label: '帮助图副标题',
          bottomHelpMessage: '标题右侧的小字，留空则显示插件名',
          component: 'Input',
          componentProps: { placeholder: 'DeepChat-plugin' }
        },
        {
          field: 'helpWidth',
          label: '帮助图宽度（px）',
          bottomHelpMessage: '渲染出来的图片宽度，600 ~ 2400',
          component: 'InputNumber',
          componentProps: { min: 600, max: 2400, step: 20, placeholder: '1200' }
        }
      ],

      getConfigData() {
        // promptIndex 是「人设文件」的映射，不是普通配置项：
        // 每次现从文件里算，而且**只回名字、不回内容** —— 内容进了请求体就会撞 100KB
        return { ...Cfg.getAll(), promptIndex: Prompt.panelRows() }
      },

      setConfigData(data, { Result }) {
        if (Array.isArray(data?.promptIndex)) {
          Prompt.applyPanelRows(data.promptIndex)
        }
        const plain = { ...data }
        delete plain.promptIndex        // 这栏只往文件里写，不进配置
        Cfg.setMany(plain)
        return Result.ok({}, '保存成功')
      }
    }
  }
}
