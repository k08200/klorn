import Foundation

// The Korean set of the main-window fixtures (`--render-previews` with
// `-klorn.appLanguage ko`). Same lanes, counts, accounts and clock as the
// English set in PreviewRenderNav.swift, written as Korean business mail so a
// Korean capture is not Korean chrome around English mail. Demo DATA, not UI
// copy: lane chips stay the product's English labels.

/// Which fixture set a render uses. Korean when the app language resolves
/// to `ko`, English for everything else.
enum PreviewFixtureLocale: Equatable, Sendable {
    case english
    case korean

    static func resolve(code: String) -> PreviewFixtureLocale {
        code == "ko" ? .korean : .english
    }

    static var current: PreviewFixtureLocale {
        resolve(code: L10n.resolvedCode(override: L10n.override))
    }
}

extension PreviewRender {
    static let navFirewallJSONKo = """
    {"tiers":{"PUSH":[
      {"id":"p1","source":"email","sourceId":"e1","type":"email","title":"계약서 검토",
       "tier":"PUSH","tierReason":"이 발신자에게 6번 답장함","priority":9,
       "surfacedAt":"2026-07-29T08:12:00Z",
       "email":{"emailDbId":"d1","source":{"provider":"GOOGLE","accountId":null,"label":"you@company.example"},
                "unread":true,"hasAttachment":true,"replyState":"needsReply","subject":"계약서 검토 — 오늘 중 서명 부탁드립니다",
                "from":"김서연 <seoyeon.kim@northwind-partners.example>","receivedAt":"2026-07-29T08:12:00Z"},"hashStale":false},
      {"id":"p2","source":"email","sourceId":"e2","type":"email","title":"청구서 기한 초과",
       "tier":"PUSH","tierReason":"오늘 결제 기한","priority":8,"surfacedAt":"2026-07-29T07:40:00Z",
       "email":{"emailDbId":"d2","source":{"provider":"GOOGLE","accountId":null,"label":"you@company.example"},
                "unread":true,"hasAttachment":false,"subject":"청구서 #4821 결제 기한이 지났습니다",
                "from":"한빛솔루션 정산팀 <billing@hanbit.example>","receivedAt":"2026-07-29T07:40:00Z"},"hashStale":false},
      {"id":"p3","source":"email","sourceId":"e3","type":"email","title":"서명 대기",
       "tier":"PUSH","tierReason":"어제부터 두 명이 기다리는 중","priority":7,
       "surfacedAt":"2026-07-29T07:05:00Z",
       "email":{"emailDbId":"d3","source":{"provider":"GOOGLE","accountId":null,"label":"you@company.example"},
                "unread":false,"hasAttachment":false,"replyState":"needsReply","draftReady":true,"subject":"서명해 주셔야 출시할 수 있습니다",
                "from":"박준호 <junho.park@team.example>","receivedAt":"2026-07-29T07:05:00Z"},"hashStale":false}],
      "MEETING":[
      {"id":"m1","source":"email","sourceId":"e4","type":"email","title":"스탠드업 변경",
       "tier":"MEETING","tierReason":"일정 변경 — 캘린더 충돌 없음","priority":5,
       "surfacedAt":"2026-07-29T06:50:00Z",
       "email":{"emailDbId":"d4","source":{"provider":"GOOGLE","accountId":null,"label":"you@company.example"},
                "unread":false,"hasAttachment":false,"subject":"스탠드업 10:30으로 변경",
                "from":"박준호 <junho.park@team.example>","receivedAt":"2026-07-29T06:50:00Z"},"hashStale":false},
      {"id":"m2","source":"email","sourceId":"e5","type":"email","title":"이사회 준비",
       "tier":"MEETING","tierReason":"목요일 초대 — 일정 1건 겹침","priority":5,
       "surfacedAt":"2026-07-29T05:31:00Z",
       "email":{"emailDbId":"d5","source":{"provider":"ICLOUD","accountId":"li-3","label":"you@icloud.example"},
                "unread":true,"hasAttachment":false,"subject":"초대: 3분기 이사회 준비, 목요일 14:00",
                "from":"이지은 <jieun.lee@northwind.example>","receivedAt":"2026-07-29T05:31:00Z"},"hashStale":false}],
      "QUEUE":[
      {"id":"q1","source":"email","sourceId":"e6","type":"email","title":"디자인 리뷰 메모",
       "tier":"QUEUE","tierReason":"동료 메일, 기한 없음","priority":4,"surfacedAt":"2026-07-29T06:20:00Z",
       "email":{"emailDbId":"d6","source":{"provider":"GOOGLE","accountId":null,"label":"you@company.example"},
                "unread":false,"hasAttachment":false,"subject":"온보딩 디자인 리뷰 메모",
                "from":"최민지 <minji.choi@team.example>","snippet":"오늘 아침 리뷰에서 남은 질문 세 가지입니다.",
                "receivedAt":"2026-07-29T06:20:00Z","signal":{"kind":"category","category":"internal"}},"hashStale":false},
      {"id":"q2","source":"email","sourceId":"e7","type":"email","title":"갱신 견적",
       "tier":"QUEUE","tierReason":"벤더 견적 — 갱신은 다음 달","priority":4,
       "surfacedAt":"2026-07-29T05:58:00Z",
       "email":{"emailDbId":"d7","source":{"provider":"NAVER","accountId":"li-1","label":"you@naver.example"},
                "unread":true,"hasAttachment":true,"subject":"2027년 갱신 견적서 보내드립니다",
                "from":"정우진 <woojin.jung@datahost.example>","snippet":"말씀 나눈 견적서를 첨부합니다.",
                "receivedAt":"2026-07-29T05:58:00Z","signal":{"kind":"replied","count":3}},"hashStale":false},
      {"id":"q3","source":"email","sourceId":"e8","type":"email","title":"후보자 자료",
       "tier":"QUEUE","tierReason":"지켜보는 채용 스레드","priority":3,"surfacedAt":"2026-07-29T05:12:00Z",
       "email":{"emailDbId":"d8","source":{"provider":"GOOGLE","accountId":null,"label":"you@company.example"},
                "unread":false,"hasAttachment":true,"subject":"후보자 자료: 시니어 백엔드 엔지니어",
                "from":"강도현 <dohyun.kang@team.example>","snippet":"면접은 금요일입니다.",
                "receivedAt":"2026-07-29T05:12:00Z","signal":{"kind":"category","category":"internal"}},"hashStale":false},
      {"id":"q4","source":"email","sourceId":"e9","type":"email","title":"고객 문의",
       "tier":"QUEUE","tierReason":"고객 문의 — 급하지 않음","priority":3,"surfacedAt":"2026-07-29T04:44:00Z",
       "email":{"emailDbId":"d9","source":{"provider":"NAVER","accountId":"li-1","label":"you@naver.example"},
                "unread":true,"hasAttachment":false,"subject":"팀 플랜 내보내기 한도 문의: 한도가 결제 주기 기준으로 초기화되는지, 매월 1일 기준으로 초기화되는지 궁금합니다",
                "from":"윤하늘 <haneul.yoon@brightlabs.example>","snippet":"지난주에 한도에 두 번 걸렸습니다.",
                "receivedAt":"2026-07-29T04:44:00Z","signal":{"kind":"category","category":"customer"}},"hashStale":false},
      {"id":"q5","source":"email","sourceId":"e10","type":"email","title":"워크숍 준비",
       "tier":"QUEUE","tierReason":"준비 스레드 — 금요일까지 회신","priority":3,"surfacedAt":"2026-07-29T03:30:00Z",
       "email":{"emailDbId":"d10","source":{"provider":"ICLOUD","accountId":"li-3","label":"you@icloud.example"},
                "unread":false,"hasAttachment":false,"subject":"워크숍 준비: 숙소와 이동편",
                "from":"한지민, 노스윈드 파트너스 인터내셔널 업무환경·출장지원팀 매니저 <jimin.han@team.example>","snippet":"참석 일정을 확인해 주세요.",
                "receivedAt":"2026-07-29T03:30:00Z"},"hashStale":false},
      {"id":"q6","source":"email","sourceId":"e11","type":"email","title":"주간 뉴스레터",
       "tier":"QUEUE","tierReason":"매주 열어 보는 뉴스레터","priority":2,"surfacedAt":"2026-07-29T02:10:00Z",
       "email":{"emailDbId":"d11","source":{"provider":"NAVER","accountId":"li-1","label":"you@naver.example"},
                "unread":false,"hasAttachment":false,"subject":"이번 주 개발 도구 소식",
                "from":"데브레터 <hello@devletter.example>","snippet":"살펴볼 만한 신규 출시 12건.",
                "receivedAt":"2026-07-29T02:10:00Z","signal":{"kind":"category","category":"promotions"}},"hashStale":false}],
      "INFO":[
      {"id":"i1","source":"email","sourceId":"e12","type":"email","title":"로그인 알림",
       "tier":"INFO","tierReason":"자동 보안 알림","priority":2,"surfacedAt":"2026-07-29T04:05:00Z",
       "email":{"emailDbId":"d12","source":{"provider":"GOOGLE","accountId":null,"label":"you@company.example"},
                "unread":false,"hasAttachment":false,"subject":"계정에 새 로그인이 있었습니다",
                "from":"계정 보안 <noreply@accounts.example>","receivedAt":"2026-07-29T04:04:00Z"},"hashStale":false}],
      "SILENT":[],"AUTO":[]},
     "summary":{"PUSH":3,"MEETING":2,"QUEUE":14,"INFO":9,"SILENT":41,"AUTO":0,"total":69}}
    """

    static let navEmailJSONKo = """
    {"id":"d6","from":"최민지 <minji.choi@team.example>",
     "subject":"온보딩 디자인 리뷰 메모",
     "date":"2026-07-29T06:20:00Z",
     "summary":"온보딩 리뷰에서 남은 질문 세 가지: 계정 연결 단계의 순서, 첫 동기화 전 오늘 화면, 문구 검수 담당자.",
     "needsReply":false,
     "text":"안녕하세요,\\n\\n오늘 아침 리뷰 내용 정리해 드립니다. 아직 정해지지 않은 건 세 가지입니다.\\n\\n1. 계정 연결 단계를 레인 안내 앞에 둘지 뒤에 둘지\\n2. 첫 동기화가 끝나기 전 오늘 화면에 무엇을 보여 줄지\\n3. 문구 검수를 누가 맡을지\\n\\n급한 건 없습니다. 목요일에 의견 모아서 정리하겠습니다.\\n\\n최민지 드림",
     "engagement":{"outboundCount":3,"learnedImportance":0.61}}
    """

    static let navBriefingJSONKo = """
    {"dateLabel":"오늘",
     "headline":"오전은 비어 있고, 17:00부터 회의가 4건 있습니다. 오늘 마감인 일은 계약서 서명 하나뿐입니다.",
     "segments":[
       {"label":"12:00 이전","summary":"일정 없음","kind":"free"},
       {"label":"12:00 ~ 17:00","summary":"5시간 비어 있음","kind":"free"},
       {"label":"17:00 이후","summary":"회의 4건","kind":"busy"}],
     "curve":[0,0,0,0,0,0,0,0,0,1,2,1],
     "dayStartHour":8,
     "attention":[{"rank":1,"action":"17:00 전에 계약서 서명","reason":"상대방이 오늘 날인합니다"}]}
    """

    static let navTodayJSONKo = """
    {"total":4,
     "current":{"id":"t1","title":"주간 계획","startTime":"2026-07-29T08:00:00Z",
                "endTime":"2026-07-29T09:00:00Z","location":null,"meetingLink":"https://meet.example/plan","allDay":false},
     "upcoming":[
       {"id":"t2","title":"스탠드업","startTime":"2026-07-29T09:30:00Z","endTime":"2026-07-29T09:45:00Z",
        "location":null,"meetingLink":"https://meet.example/standup","allDay":false},
       {"id":"t3","title":"디자인 리뷰","startTime":"2026-07-29T10:00:00Z","endTime":"2026-07-29T11:00:00Z",
        "location":null,"meetingLink":null,"allDay":false},
       {"id":"t4","title":"파트너 통화","startTime":"2026-07-29T11:30:00Z","endTime":"2026-07-29T12:00:00Z",
        "location":null,"meetingLink":null,"allDay":false}],
     "nextEvent":null}
    """

    static let navActionsJSONKo = """
    [{"id":"a1","toolName":"send_email","targetLabel":"김서연 님께 회신: 서명한 계약서 첨부",
      "reasoning":"지난주 같은 조항을 승인하셨고, 오늘이 기한입니다.","createdAt":"2026-07-29T08:20:00Z"},
     {"id":"a2","toolName":"create_calendar_event","targetLabel":"3분기 이사회 준비, 목요일 14:00 ~ 15:00",
      "reasoning":"집중 시간 하나를 옮기면 일정에 들어갑니다.","createdAt":"2026-07-29T05:40:00Z"}]
    """

    static let navCommitmentsJSONKo = """
    [{"id":"k1","title":"수정 견적서 보내기","owner":"ME","counterpartyName":"정우진",
      "counterpartyEmail":null,"dueText":"금요일","status":"OPEN"},
     {"id":"k2","title":"이사회 자료용 3분기 수치","owner":"COUNTERPARTY","counterpartyName":"이지은",
      "counterpartyEmail":null,"dueText":null,"status":"OPEN"}]
    """

    static let navChatJSONKo = """
    ["정오 전에 제가 처리할 일이 뭐예요?",
     "**두 가지입니다.** 김서연 님 계약서 서명이 17:00까지이고, 회신 초안은 이미 준비돼 있습니다. 박준호 님은 문구 변경 승인을 기다리며 출시를 보류하고 있습니다. 나머지는 디자인 리뷰 뒤에 보셔도 됩니다."]
    """
}
