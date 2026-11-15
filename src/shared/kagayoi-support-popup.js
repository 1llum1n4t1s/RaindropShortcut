(() => {
  "use strict"

  const DEFAULT_API_BASE = "https://support.kagayoi.com"
  const SESSION_KEY = "kagayoi-support-session"
  const API_TIMEOUT_MS = 15_000
  const FORM_STYLESHEET_URL = bundledStylesheetUrl("kagayoi-support-form.css")
  const POPUP_STYLESHEET_URL = bundledStylesheetUrl("kagayoi-support-popup.css")
  const FIREFOX_OPTIONAL_CONTACT_DATA_PERMISSIONS = ["personalCommunications"]
  const CHANNELS = new Set(["web", "desktop", "extension", "other"])
  const STORAGE_SCOPES = new Set(["session", "local"])
  const CATEGORIES = [
    ["question", "使い方・ご質問"],
    ["bug", "不具合のご報告"],
    ["feature", "機能のご要望"],
    ["billing", "料金・ご依頼"],
    ["other", "その他"],
  ]
  const ERROR_LABELS = {
    "invalid email": "メールアドレスを確認してください。",
    "too many requests": "短時間に送信が集中しています。少し時間を置いてからお試しください。",
    "email unavailable": "確認メールを送信できませんでした。時間を置いてからお試しください。",
    "invalid code": "確認コードが正しくありません。",
    "code expired or locked": "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。",
    "code already used": "この確認コードは使用済みです。新しいコードを取得してください。",
    "authentication required": "認証の有効期限が切れました。確認コードを取得し直してください。",
    "invalid session": "認証の有効期限が切れました。確認コードを取得し直してください。",
    "invalid ticket": "入力内容を確認してください。",
    "invalid ticket metadata": "入力内容が長すぎます。",
    "unknown product": "お問い合わせ先を確認できませんでした。",
    "request too large": "お問い合わせ内容が長すぎます。",
    "origin not allowed": "このサイトからは現在送信できません。",
  }

  // 表示言語は 9 コード（ja と、下の MESSAGES が持つ 8 言語）。ja は原文キーそのものが文言なので辞書を持たない。
  // 辞書のキーは日本語原文のまま。全言語でキー集合を一致させること（テストで検証する）。
  // 差し込み {product} / {email} は全言語で同一の名前を保つ。Kagayoi は固有名詞なので訳さない。
  // intro / introAfter は「製品名」を挟む前後の文で、語順の違う言語でも自然になるよう前後に分けている
  // （前が空の言語がある。translate() は空文字も有効な訳として扱う）。
  const MESSAGES = {
    en: {
      "このサイト": "this site",
      "お問い合わせ": "Contact support",
      "閉じる": "Close",
      "お問い合わせフォーム": "Contact form",
      "{product}へのお問い合わせフォーム": "Contact form for {product}",
      "intro": "Send bug reports, questions, feature requests, or other inquiries about ",
      "introAfter": ". To verify your reply address, enter the six-digit code sent by email the first time you contact us.",
      "お名前": "Name",
      "（任意）": "(optional)",
      "メールアドレス": "Email address",
      "お問い合わせ種別": "Category",
      "使い方・ご質問": "Help and questions",
      "不具合のご報告": "Bug report",
      "機能のご要望": "Feature request",
      "料金・ご依頼": "Billing and requests",
      "その他": "Other",
      "件名": "Subject",
      "お問い合わせ内容": "Message",
      "6桁の確認コード": "Six-digit verification code",
      "コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。": "The code is valid for 10 minutes. If it does not arrive, check your spam folder.",
      "確認コードを再送する": "Resend verification code",
      "確認コードを送信": "Send verification code",
      "送信しています…": "Sending…",
      "お問い合わせを受け付けました": "Your inquiry has been received",
      "受付番号を控えてください。": "Please save your reference number.",
      "同じメールアドレスでログインすると、返信と対応状況を ": "Sign in with the same email address to view replies and your inquiry status on ",
      " で確認できます。": ".",
      "別のお問い合わせを送る": "Send another inquiry",
      "認証して問い合わせを送信": "Verify and send inquiry",
      "{email} へ確認コードを送りました。": "A verification code has been sent to {email}.",
      "問い合わせを送信": "Send inquiry",
      "{email} は認証済みです。": "{email} is verified.",
      "お問い合わせ情報の送信には Firefox の許可が必要です。": "Firefox permission is required to send your inquiry information.",
      "Firefox のデータ送信許可を確認できませんでした。": "Could not check Firefox permission to send inquiry information.",
      "メールアドレスを確認してください。": "Please check your email address.",
      "短時間に送信が集中しています。少し時間を置いてからお試しください。": "Too many requests. Please wait a while and try again.",
      "確認メールを送信できませんでした。時間を置いてからお試しください。": "Could not send the verification email. Please try again later.",
      "確認コードが正しくありません。": "The verification code is incorrect.",
      "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。": "The verification code has expired or too many attempts were made. Please request a new code.",
      "この確認コードは使用済みです。新しいコードを取得してください。": "This verification code has already been used. Please request a new code.",
      "認証の有効期限が切れました。確認コードを取得し直してください。": "Your verification has expired. Please request a new code.",
      "入力内容を確認してください。": "Please check the information you entered.",
      "入力内容が長すぎます。": "The information you entered is too long.",
      "お問い合わせ先を確認できませんでした。": "Could not identify the product you are contacting us about.",
      "お問い合わせ内容が長すぎます。": "Your inquiry is too long.",
      "このサイトからは現在送信できません。": "Inquiries cannot currently be sent from this site.",
      "通信できませんでした。接続を確認して、もう一度お試しください。": "Could not connect. Please check your connection and try again.",
      "送信できませんでした。時間を置いてからお試しください。": "Could not send your inquiry. Please try again later.",
      "必須項目を入力してください。": "Please fill out this required field.",
      "6桁の数字で確認コードを入力してください。": "Please enter the six-digit verification code.",
    },
    de: {
      "このサイト": "diese Website",
      "お問い合わせ": "Support kontaktieren",
      "閉じる": "Schließen",
      "お問い合わせフォーム": "Kontaktformular",
      "{product}へのお問い合わせフォーム": "Kontaktformular für {product}",
      "intro": "Senden Sie Fehlermeldungen, Fragen, Funktionswünsche oder andere Anliegen zu ",
      "introAfter": ". Zur Bestätigung Ihrer Antwortadresse geben Sie beim ersten Kontakt den sechsstelligen Code ein, den wir Ihnen per E-Mail senden.",
      "お名前": "Name",
      "（任意）": "(optional)",
      "メールアドレス": "E-Mail-Adresse",
      "お問い合わせ種別": "Kategorie",
      "使い方・ご質問": "Hilfe und Fragen",
      "不具合のご報告": "Fehlermeldung",
      "機能のご要望": "Funktionswunsch",
      "料金・ご依頼": "Abrechnung und Anfragen",
      "その他": "Sonstiges",
      "件名": "Betreff",
      "お問い合わせ内容": "Nachricht",
      "6桁の確認コード": "Sechsstelliger Bestätigungscode",
      "コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。": "Der Code ist 10 Minuten gültig. Falls er nicht ankommt, prüfen Sie bitte auch Ihren Spam-Ordner.",
      "確認コードを再送する": "Bestätigungscode erneut senden",
      "確認コードを送信": "Bestätigungscode senden",
      "送信しています…": "Wird gesendet…",
      "お問い合わせを受け付けました": "Ihre Anfrage ist eingegangen",
      "受付番号を控えてください。": "Bitte notieren Sie sich Ihre Referenznummer.",
      "同じメールアドレスでログインすると、返信と対応状況を ": "Wenn Sie sich mit derselben E-Mail-Adresse anmelden, sehen Sie Antworten und den Bearbeitungsstand Ihrer Anfrage unter ",
      " で確認できます。": ".",
      "別のお問い合わせを送る": "Weitere Anfrage senden",
      "認証して問い合わせを送信": "Bestätigen und Anfrage senden",
      "{email} へ確認コードを送りました。": "Ein Bestätigungscode wurde an {email} gesendet.",
      "問い合わせを送信": "Anfrage senden",
      "{email} は認証済みです。": "{email} ist bestätigt.",
      "お問い合わせ情報の送信には Firefox の許可が必要です。": "Zum Senden Ihrer Anfrage ist die Berechtigung von Firefox erforderlich.",
      "Firefox のデータ送信許可を確認できませんでした。": "Die Firefox-Berechtigung zum Senden der Anfragedaten konnte nicht geprüft werden.",
      "メールアドレスを確認してください。": "Bitte prüfen Sie Ihre E-Mail-Adresse.",
      "短時間に送信が集中しています。少し時間を置いてからお試しください。": "Zu viele Anfragen in kurzer Zeit. Bitte warten Sie einen Moment und versuchen Sie es erneut.",
      "確認メールを送信できませんでした。時間を置いてからお試しください。": "Die Bestätigungs-E-Mail konnte nicht gesendet werden. Bitte versuchen Sie es später erneut.",
      "確認コードが正しくありません。": "Der Bestätigungscode ist falsch.",
      "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。": "Der Bestätigungscode ist abgelaufen oder die Anzahl der Versuche wurde überschritten. Bitte fordern Sie einen neuen Code an.",
      "この確認コードは使用済みです。新しいコードを取得してください。": "Dieser Bestätigungscode wurde bereits verwendet. Bitte fordern Sie einen neuen Code an.",
      "認証の有効期限が切れました。確認コードを取得し直してください。": "Ihre Bestätigung ist abgelaufen. Bitte fordern Sie einen neuen Code an.",
      "入力内容を確認してください。": "Bitte prüfen Sie Ihre Eingaben.",
      "入力内容が長すぎます。": "Ihre Eingaben sind zu lang.",
      "お問い合わせ先を確認できませんでした。": "Das Produkt, zu dem Sie uns kontaktieren, konnte nicht ermittelt werden.",
      "お問い合わせ内容が長すぎます。": "Ihre Anfrage ist zu lang.",
      "このサイトからは現在送信できません。": "Von dieser Website können derzeit keine Anfragen gesendet werden.",
      "通信できませんでした。接続を確認して、もう一度お試しください。": "Es konnte keine Verbindung hergestellt werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
      "送信できませんでした。時間を置いてからお試しください。": "Ihre Anfrage konnte nicht gesendet werden. Bitte versuchen Sie es später erneut.",
      "必須項目を入力してください。": "Bitte füllen Sie dieses Pflichtfeld aus.",
      "6桁の数字で確認コードを入力してください。": "Bitte geben Sie den sechsstelligen Bestätigungscode ein.",
    },
    es: {
      "このサイト": "este sitio",
      "お問い合わせ": "Contactar con soporte",
      "閉じる": "Cerrar",
      "お問い合わせフォーム": "Formulario de contacto",
      "{product}へのお問い合わせフォーム": "Formulario de contacto de {product}",
      "intro": "Envíe informes de errores, preguntas, solicitudes de funciones u otras consultas sobre ",
      "introAfter": ". Para verificar su dirección de respuesta, introduzca el código de seis dígitos que recibirá por correo electrónico la primera vez que nos contacte.",
      "お名前": "Nombre",
      "（任意）": "(opcional)",
      "メールアドレス": "Correo electrónico",
      "お問い合わせ種別": "Categoría",
      "使い方・ご質問": "Ayuda y preguntas",
      "不具合のご報告": "Informe de error",
      "機能のご要望": "Solicitud de función",
      "料金・ご依頼": "Facturación y solicitudes",
      "その他": "Otros",
      "件名": "Asunto",
      "お問い合わせ内容": "Mensaje",
      "6桁の確認コード": "Código de verificación de seis dígitos",
      "コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。": "El código es válido durante 10 minutos. Si no lo recibe, revise también su carpeta de correo no deseado.",
      "確認コードを再送する": "Reenviar código de verificación",
      "確認コードを送信": "Enviar código de verificación",
      "送信しています…": "Enviando…",
      "お問い合わせを受け付けました": "Hemos recibido su consulta",
      "受付番号を控えてください。": "Conserve su número de referencia.",
      "同じメールアドレスでログインすると、返信と対応状況を ": "Inicie sesión con el mismo correo electrónico para ver las respuestas y el estado de su consulta en ",
      " で確認できます。": ".",
      "別のお問い合わせを送る": "Enviar otra consulta",
      "認証して問い合わせを送信": "Verificar y enviar consulta",
      "{email} へ確認コードを送りました。": "Se ha enviado un código de verificación a {email}.",
      "問い合わせを送信": "Enviar consulta",
      "{email} は認証済みです。": "{email} está verificado.",
      "お問い合わせ情報の送信には Firefox の許可が必要です。": "Se necesita el permiso de Firefox para enviar la información de su consulta.",
      "Firefox のデータ送信許可を確認できませんでした。": "No se pudo comprobar el permiso de Firefox para enviar la información de la consulta.",
      "メールアドレスを確認してください。": "Revise su dirección de correo electrónico.",
      "短時間に送信が集中しています。少し時間を置いてからお試しください。": "Demasiadas solicitudes en poco tiempo. Espere un momento e inténtelo de nuevo.",
      "確認メールを送信できませんでした。時間を置いてからお試しください。": "No se pudo enviar el correo de verificación. Inténtelo de nuevo más tarde.",
      "確認コードが正しくありません。": "El código de verificación no es correcto.",
      "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。": "El código de verificación ha caducado o se ha superado el número de intentos. Solicite un código nuevo.",
      "この確認コードは使用済みです。新しいコードを取得してください。": "Este código de verificación ya se ha utilizado. Solicite un código nuevo.",
      "認証の有効期限が切れました。確認コードを取得し直してください。": "Su verificación ha caducado. Solicite un código nuevo.",
      "入力内容を確認してください。": "Revise la información introducida.",
      "入力内容が長すぎます。": "La información introducida es demasiado larga.",
      "お問い合わせ先を確認できませんでした。": "No se pudo identificar el producto sobre el que desea consultar.",
      "お問い合わせ内容が長すぎます。": "Su consulta es demasiado larga.",
      "このサイトからは現在送信できません。": "Actualmente no se pueden enviar consultas desde este sitio.",
      "通信できませんでした。接続を確認して、もう一度お試しください。": "No se pudo conectar. Compruebe su conexión e inténtelo de nuevo.",
      "送信できませんでした。時間を置いてからお試しください。": "No se pudo enviar su consulta. Inténtelo de nuevo más tarde.",
      "必須項目を入力してください。": "Complete este campo obligatorio.",
      "6桁の数字で確認コードを入力してください。": "Introduzca el código de verificación de seis dígitos.",
    },
    fr: {
      "このサイト": "ce site",
      "お問い合わせ": "Contacter le support",
      "閉じる": "Fermer",
      "お問い合わせフォーム": "Formulaire de contact",
      "{product}へのお問い合わせフォーム": "Formulaire de contact pour {product}",
      "intro": "Envoyez des signalements de bugs, des questions, des demandes de fonctionnalités ou toute autre demande concernant ",
      "introAfter": ". Pour vérifier votre adresse de réponse, saisissez le code à six chiffres reçu par e-mail lors de votre premier contact.",
      "お名前": "Nom",
      "（任意）": "(facultatif)",
      "メールアドレス": "Adresse e-mail",
      "お問い合わせ種別": "Catégorie",
      "使い方・ご質問": "Aide et questions",
      "不具合のご報告": "Signalement de bug",
      "機能のご要望": "Demande de fonctionnalité",
      "料金・ご依頼": "Facturation et demandes",
      "その他": "Autre",
      "件名": "Objet",
      "お問い合わせ内容": "Message",
      "6桁の確認コード": "Code de vérification à six chiffres",
      "コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。": "Le code est valable 10 minutes. S’il n’arrive pas, vérifiez également votre dossier de courrier indésirable.",
      "確認コードを再送する": "Renvoyer le code de vérification",
      "確認コードを送信": "Envoyer le code de vérification",
      "送信しています…": "Envoi en cours…",
      "お問い合わせを受け付けました": "Votre demande a bien été reçue",
      "受付番号を控えてください。": "Veuillez noter votre numéro de référence.",
      "同じメールアドレスでログインすると、返信と対応状況を ": "Connectez-vous avec la même adresse e-mail pour consulter les réponses et l’état de votre demande sur ",
      " で確認できます。": ".",
      "別のお問い合わせを送る": "Envoyer une autre demande",
      "認証して問い合わせを送信": "Vérifier et envoyer la demande",
      "{email} へ確認コードを送りました。": "Un code de vérification a été envoyé à {email}.",
      "問い合わせを送信": "Envoyer la demande",
      "{email} は認証済みです。": "{email} est vérifiée.",
      "お問い合わせ情報の送信には Firefox の許可が必要です。": "L’autorisation de Firefox est nécessaire pour envoyer les informations de votre demande.",
      "Firefox のデータ送信許可を確認できませんでした。": "Impossible de vérifier l’autorisation de Firefox pour l’envoi des informations de la demande.",
      "メールアドレスを確認してください。": "Veuillez vérifier votre adresse e-mail.",
      "短時間に送信が集中しています。少し時間を置いてからお試しください。": "Trop de requêtes en peu de temps. Veuillez patienter un instant, puis réessayer.",
      "確認メールを送信できませんでした。時間を置いてからお試しください。": "Impossible d’envoyer l’e-mail de vérification. Veuillez réessayer plus tard.",
      "確認コードが正しくありません。": "Le code de vérification est incorrect.",
      "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。": "Le code de vérification a expiré ou le nombre maximal de tentatives a été atteint. Veuillez demander un nouveau code.",
      "この確認コードは使用済みです。新しいコードを取得してください。": "Ce code de vérification a déjà été utilisé. Veuillez demander un nouveau code.",
      "認証の有効期限が切れました。確認コードを取得し直してください。": "Votre vérification a expiré. Veuillez demander un nouveau code.",
      "入力内容を確認してください。": "Veuillez vérifier les informations saisies.",
      "入力内容が長すぎます。": "Les informations saisies sont trop longues.",
      "お問い合わせ先を確認できませんでした。": "Impossible d’identifier le produit concerné par votre demande.",
      "お問い合わせ内容が長すぎます。": "Votre demande est trop longue.",
      "このサイトからは現在送信できません。": "Les demandes ne peuvent actuellement pas être envoyées depuis ce site.",
      "通信できませんでした。接続を確認して、もう一度お試しください。": "Connexion impossible. Veuillez vérifier votre connexion, puis réessayer.",
      "送信できませんでした。時間を置いてからお試しください。": "Impossible d’envoyer votre demande. Veuillez réessayer plus tard.",
      "必須項目を入力してください。": "Veuillez renseigner ce champ obligatoire.",
      "6桁の数字で確認コードを入力してください。": "Veuillez saisir le code de vérification à six chiffres.",
    },
    ko: {
      "このサイト": "이 사이트",
      "お問い合わせ": "문의하기",
      "閉じる": "닫기",
      "お問い合わせフォーム": "문의 양식",
      "{product}へのお問い合わせフォーム": "{product} 문의 양식",
      "intro": "",
      "introAfter": "에 대한 버그 신고, 질문, 기능 요청 또는 기타 문의를 보내실 수 있습니다. 회신 주소를 확인하기 위해 처음 문의하실 때는 이메일로 받은 6자리 코드를 입력해 주세요.",
      "お名前": "이름",
      "（任意）": "(선택)",
      "メールアドレス": "이메일 주소",
      "お問い合わせ種別": "문의 유형",
      "使い方・ご質問": "사용법 및 질문",
      "不具合のご報告": "버그 신고",
      "機能のご要望": "기능 요청",
      "料金・ご依頼": "요금 및 의뢰",
      "その他": "기타",
      "件名": "제목",
      "お問い合わせ内容": "문의 내용",
      "6桁の確認コード": "6자리 확인 코드",
      "コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。": "코드는 10분간 유효합니다. 도착하지 않으면 스팸 메일함도 확인해 주세요.",
      "確認コードを再送する": "확인 코드 다시 보내기",
      "確認コードを送信": "확인 코드 보내기",
      "送信しています…": "전송 중…",
      "お問い合わせを受け付けました": "문의가 접수되었습니다",
      "受付番号を控えてください。": "접수 번호를 메모해 두세요.",
      "同じメールアドレスでログインすると、返信と対応状況を ": "같은 이메일 주소로 로그인하시면 답변과 처리 현황을 ",
      " で確認できます。": " 에서 확인하실 수 있습니다.",
      "別のお問い合わせを送る": "다른 문의 보내기",
      "認証して問い合わせを送信": "인증 후 문의 보내기",
      "{email} へ確認コードを送りました。": "{email}(으)로 확인 코드를 보냈습니다.",
      "問い合わせを送信": "문의 보내기",
      "{email} は認証済みです。": "{email}은(는) 인증되었습니다.",
      "お問い合わせ情報の送信には Firefox の許可が必要です。": "문의 정보를 보내려면 Firefox의 허용이 필요합니다.",
      "Firefox のデータ送信許可を確認できませんでした。": "Firefox의 데이터 전송 허용 여부를 확인하지 못했습니다.",
      "メールアドレスを確認してください。": "이메일 주소를 확인해 주세요.",
      "短時間に送信が集中しています。少し時間を置いてからお試しください。": "짧은 시간에 요청이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.",
      "確認メールを送信できませんでした。時間を置いてからお試しください。": "확인 이메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.",
      "確認コードが正しくありません。": "확인 코드가 올바르지 않습니다.",
      "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。": "확인 코드의 유효 기간이 지났거나 입력 횟수 제한에 도달했습니다. 새 코드를 받아 주세요.",
      "この確認コードは使用済みです。新しいコードを取得してください。": "이 확인 코드는 이미 사용되었습니다. 새 코드를 받아 주세요.",
      "認証の有効期限が切れました。確認コードを取得し直してください。": "인증 유효 기간이 지났습니다. 확인 코드를 다시 받아 주세요.",
      "入力内容を確認してください。": "입력한 내용을 확인해 주세요.",
      "入力内容が長すぎます。": "입력한 내용이 너무 깁니다.",
      "お問い合わせ先を確認できませんでした。": "문의 대상을 확인하지 못했습니다.",
      "お問い合わせ内容が長すぎます。": "문의 내용이 너무 깁니다.",
      "このサイトからは現在送信できません。": "현재 이 사이트에서는 문의를 보낼 수 없습니다.",
      "通信できませんでした。接続を確認して、もう一度お試しください。": "통신하지 못했습니다. 연결을 확인한 후 다시 시도해 주세요.",
      "送信できませんでした。時間を置いてからお試しください。": "문의를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.",
      "必須項目を入力してください。": "필수 항목을 입력해 주세요.",
      "6桁の数字で確認コードを入力してください。": "6자리 숫자로 확인 코드를 입력해 주세요.",
    },
    pt_BR: {
      "このサイト": "este site",
      "お問い合わせ": "Falar com o suporte",
      "閉じる": "Fechar",
      "お問い合わせフォーム": "Formulário de contato",
      "{product}へのお問い合わせフォーム": "Formulário de contato de {product}",
      "intro": "Envie relatos de erros, dúvidas, pedidos de recursos ou outras solicitações sobre ",
      "introAfter": ". Para confirmar seu endereço de resposta, informe o código de seis dígitos enviado por e-mail no seu primeiro contato.",
      "お名前": "Nome",
      "（任意）": "(opcional)",
      "メールアドレス": "Endereço de e-mail",
      "お問い合わせ種別": "Categoria",
      "使い方・ご質問": "Ajuda e dúvidas",
      "不具合のご報告": "Relato de erro",
      "機能のご要望": "Pedido de recurso",
      "料金・ご依頼": "Cobrança e solicitações",
      "その他": "Outros",
      "件名": "Assunto",
      "お問い合わせ内容": "Mensagem",
      "6桁の確認コード": "Código de verificação de seis dígitos",
      "コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。": "O código é válido por 10 minutos. Se ele não chegar, verifique também a pasta de spam.",
      "確認コードを再送する": "Reenviar código de verificação",
      "確認コードを送信": "Enviar código de verificação",
      "送信しています…": "Enviando…",
      "お問い合わせを受け付けました": "Sua solicitação foi recebida",
      "受付番号を控えてください。": "Anote o seu número de protocolo.",
      "同じメールアドレスでログインすると、返信と対応状況を ": "Entre com o mesmo endereço de e-mail para ver as respostas e o andamento da sua solicitação em ",
      " で確認できます。": ".",
      "別のお問い合わせを送る": "Enviar outra solicitação",
      "認証して問い合わせを送信": "Verificar e enviar solicitação",
      "{email} へ確認コードを送りました。": "Enviamos um código de verificação para {email}.",
      "問い合わせを送信": "Enviar solicitação",
      "{email} は認証済みです。": "{email} está verificado.",
      "お問い合わせ情報の送信には Firefox の許可が必要です。": "É necessária a permissão do Firefox para enviar as informações da sua solicitação.",
      "Firefox のデータ送信許可を確認できませんでした。": "Não foi possível verificar a permissão do Firefox para enviar as informações da solicitação.",
      "メールアドレスを確認してください。": "Verifique seu endereço de e-mail.",
      "短時間に送信が集中しています。少し時間を置いてからお試しください。": "Muitas solicitações em pouco tempo. Aguarde um momento e tente novamente.",
      "確認メールを送信できませんでした。時間を置いてからお試しください。": "Não foi possível enviar o e-mail de verificação. Tente novamente mais tarde.",
      "確認コードが正しくありません。": "O código de verificação está incorreto.",
      "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。": "O código de verificação expirou ou o limite de tentativas foi atingido. Solicite um novo código.",
      "この確認コードは使用済みです。新しいコードを取得してください。": "Este código de verificação já foi usado. Solicite um novo código.",
      "認証の有効期限が切れました。確認コードを取得し直してください。": "Sua verificação expirou. Solicite um novo código.",
      "入力内容を確認してください。": "Verifique as informações digitadas.",
      "入力内容が長すぎます。": "As informações digitadas são muito longas.",
      "お問い合わせ先を確認できませんでした。": "Não foi possível identificar o produto sobre o qual você quer falar.",
      "お問い合わせ内容が長すぎます。": "Sua solicitação é muito longa.",
      "このサイトからは現在送信できません。": "No momento, não é possível enviar solicitações a partir deste site.",
      "通信できませんでした。接続を確認して、もう一度お試しください。": "Não foi possível se conectar. Verifique sua conexão e tente novamente.",
      "送信できませんでした。時間を置いてからお試しください。": "Não foi possível enviar sua solicitação. Tente novamente mais tarde.",
      "必須項目を入力してください。": "Preencha este campo obrigatório.",
      "6桁の数字で確認コードを入力してください。": "Informe o código de verificação de seis dígitos.",
    },
    zh_CN: {
      "このサイト": "本网站",
      "お問い合わせ": "联系支持",
      "閉じる": "关闭",
      "お問い合わせフォーム": "联系表单",
      "{product}へのお問い合わせフォーム": "{product} 联系表单",
      "intro": "您可以就 ",
      "introAfter": " 提交错误报告、问题、功能需求或其他咨询。为确认您的回复邮箱，首次联系时请输入通过电子邮件收到的 6 位验证码。",
      "お名前": "姓名",
      "（任意）": "（选填）",
      "メールアドレス": "电子邮箱",
      "お問い合わせ種別": "咨询类别",
      "使い方・ご質問": "使用帮助与问题",
      "不具合のご報告": "错误报告",
      "機能のご要望": "功能需求",
      "料金・ご依頼": "费用与委托",
      "その他": "其他",
      "件名": "主题",
      "お問い合わせ内容": "咨询内容",
      "6桁の確認コード": "6 位验证码",
      "コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。": "验证码 10 分钟内有效。如果没有收到，请同时检查垃圾邮件文件夹。",
      "確認コードを再送する": "重新发送验证码",
      "確認コードを送信": "发送验证码",
      "送信しています…": "正在发送…",
      "お問い合わせを受け付けました": "已收到您的咨询",
      "受付番号を控えてください。": "请记下您的受理编号。",
      "同じメールアドレスでログインすると、返信と対応状況を ": "使用相同的电子邮箱登录后，即可在 ",
      " で確認できます。": " 查看回复和处理进度。",
      "別のお問い合わせを送る": "提交其他咨询",
      "認証して問い合わせを送信": "验证并提交咨询",
      "{email} へ確認コードを送りました。": "验证码已发送至 {email}。",
      "問い合わせを送信": "提交咨询",
      "{email} は認証済みです。": "{email} 已通过验证。",
      "お問い合わせ情報の送信には Firefox の許可が必要です。": "发送咨询信息需要获得 Firefox 的授权。",
      "Firefox のデータ送信許可を確認できませんでした。": "无法确认 Firefox 的数据发送授权。",
      "メールアドレスを確認してください。": "请检查电子邮箱地址。",
      "短時間に送信が集中しています。少し時間を置いてからお試しください。": "短时间内请求过多，请稍后再试。",
      "確認メールを送信できませんでした。時間を置いてからお試しください。": "无法发送验证邮件，请稍后再试。",
      "確認コードが正しくありません。": "验证码不正确。",
      "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。": "验证码已过期，或输入次数已达上限。请重新获取验证码。",
      "この確認コードは使用済みです。新しいコードを取得してください。": "此验证码已被使用。请重新获取验证码。",
      "認証の有効期限が切れました。確認コードを取得し直してください。": "验证已过期。请重新获取验证码。",
      "入力内容を確認してください。": "请检查输入的内容。",
      "入力内容が長すぎます。": "输入的内容过长。",
      "お問い合わせ先を確認できませんでした。": "无法确认咨询对象。",
      "お問い合わせ内容が長すぎます。": "咨询内容过长。",
      "このサイトからは現在送信できません。": "目前无法从此网站发送咨询。",
      "通信できませんでした。接続を確認して、もう一度お試しください。": "通信失败。请检查网络连接后重试。",
      "送信できませんでした。時間を置いてからお試しください。": "无法发送咨询，请稍后再试。",
      "必須項目を入力してください。": "请填写此必填项。",
      "6桁の数字で確認コードを入力してください。": "请输入 6 位数字验证码。",
    },
    zh_TW: {
      "このサイト": "本網站",
      "お問い合わせ": "聯絡支援",
      "閉じる": "關閉",
      "お問い合わせフォーム": "聯絡表單",
      "{product}へのお問い合わせフォーム": "{product} 聯絡表單",
      "intro": "您可以就 ",
      "introAfter": " 傳送錯誤回報、問題、功能需求或其他諮詢。為確認您的回覆信箱，首次聯絡時請輸入透過電子郵件收到的 6 位數驗證碼。",
      "お名前": "姓名",
      "（任意）": "（選填）",
      "メールアドレス": "電子郵件地址",
      "お問い合わせ種別": "諮詢類別",
      "使い方・ご質問": "使用說明與問題",
      "不具合のご報告": "錯誤回報",
      "機能のご要望": "功能需求",
      "料金・ご依頼": "費用與委託",
      "その他": "其他",
      "件名": "主旨",
      "お問い合わせ内容": "諮詢內容",
      "6桁の確認コード": "6 位數驗證碼",
      "コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。": "驗證碼 10 分鐘內有效。若未收到，請一併檢查垃圾郵件資料夾。",
      "確認コードを再送する": "重新傳送驗證碼",
      "確認コードを送信": "傳送驗證碼",
      "送信しています…": "傳送中…",
      "お問い合わせを受け付けました": "已收到您的諮詢",
      "受付番号を控えてください。": "請記下您的受理編號。",
      "同じメールアドレスでログインすると、返信と対応状況を ": "使用相同的電子郵件地址登入後，即可在 ",
      " で確認できます。": " 查看回覆與處理進度。",
      "別のお問い合わせを送る": "傳送其他諮詢",
      "認証して問い合わせを送信": "驗證並傳送諮詢",
      "{email} へ確認コードを送りました。": "驗證碼已傳送至 {email}。",
      "問い合わせを送信": "傳送諮詢",
      "{email} は認証済みです。": "{email} 已通過驗證。",
      "お問い合わせ情報の送信には Firefox の許可が必要です。": "傳送諮詢資訊需要取得 Firefox 的授權。",
      "Firefox のデータ送信許可を確認できませんでした。": "無法確認 Firefox 的資料傳送授權。",
      "メールアドレスを確認してください。": "請檢查電子郵件地址。",
      "短時間に送信が集中しています。少し時間を置いてからお試しください。": "短時間內請求過多，請稍後再試。",
      "確認メールを送信できませんでした。時間を置いてからお試しください。": "無法傳送驗證郵件，請稍後再試。",
      "確認コードが正しくありません。": "驗證碼不正確。",
      "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。": "驗證碼已過期，或輸入次數已達上限。請重新取得驗證碼。",
      "この確認コードは使用済みです。新しいコードを取得してください。": "此驗證碼已被使用。請重新取得驗證碼。",
      "認証の有効期限が切れました。確認コードを取得し直してください。": "驗證已過期。請重新取得驗證碼。",
      "入力内容を確認してください。": "請檢查輸入的內容。",
      "入力内容が長すぎます。": "輸入的內容過長。",
      "お問い合わせ先を確認できませんでした。": "無法確認諮詢對象。",
      "お問い合わせ内容が長すぎます。": "諮詢內容過長。",
      "このサイトからは現在送信できません。": "目前無法從此網站傳送諮詢。",
      "通信できませんでした。接続を確認して、もう一度お試しください。": "通訊失敗。請檢查網路連線後重試。",
      "送信できませんでした。時間を置いてからお試しください。": "無法傳送諮詢，請稍後再試。",
      "必須項目を入力してください。": "請填寫此必填欄位。",
      "6桁の数字で確認コードを入力してください。": "請輸入 6 位數驗證碼。",
    },
  }

  // 日本語（原文）の introAfter。製品名の前は空で、後ろだけ文が続く。
  const JA_INTRO_AFTER = "について、不具合・ご質問・ご要望・ご依頼を送信できます。返信先の確認のため、初回はメールで届く6桁のコードを入力してください。"

  /**
   * 言語タグ（<html lang>、属性 lang、i18n.getUILanguage() 等）を 9 コード
   * （ja en de es fr ko pt_BR zh_CN zh_TW）のどれかへ写像する。
   *  - ja* → ja
   *  - zh: zh-TW / zh-HK / zh-MO / zh-Hant* → zh_TW、それ以外の zh*（zh-CN / zh-Hans* / zh 単独）→ zh_CN
   *    （スクリプトと地域が食い違う zh-Hans-TW 等は、スクリプトの Hans を優先して zh_CN）
   *  - pt* → pt_BR（pt-PT も含め、同梱の訳は 1 種類のため）
   *  - en / de / es / fr / ko → そのまま
   *  - 上記以外・空 → en
   * 区切りはハイフン・アンダースコアのどちらも受け付け、大文字小文字は区別しない。
   * 同じ写像を support-footer.js にも持つ（逐語コピー配布のため別ファイル）。一致はテストで固定する。
   */
  function resolveLanguage(tag) {
    const [primary, ...subtags] = String(tag ?? "").trim().toLowerCase().replaceAll("_", "-").split("-")
    switch (primary) {
      case "ja": return "ja"
      case "zh":
        if (subtags.includes("hans")) return "zh_CN"
        return subtags.some((subtag) => ["tw", "hk", "mo", "hant"].includes(subtag)) ? "zh_TW" : "zh_CN"
      case "pt": return "pt_BR"
      case "en": case "de": case "es": case "fr": case "ko": return primary
      default: return "en"
    }
  }

  /** 内部コードを HTML の lang 属性に使える BCP 47 形式へ戻す（zh_CN → zh-CN）。 */
  function languageTag(language) {
    return language.replace("_", "-")
  }

  function uiLanguage(host) {
    const api = globalThis.browser ?? globalThis.chrome
    const tag = host.closest("[lang]")?.getAttribute("lang")?.trim()
      || document.documentElement.lang?.trim() || api?.i18n?.getUILanguage?.() || "ja"
    return resolveLanguage(tag)
  }

  function translate(language, message, values = {}) {
    // 空文字の訳（ko の intro など）も有効なので、truthy ではなく「キーがあるか」で判定する。
    const dictionary = MESSAGES[language]
    const text = dictionary && Object.hasOwn(dictionary, message) ? dictionary[message] : message
    return text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match)
  }

  function bundledStylesheetUrl(fileName) {
    const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null
    if (api?.runtime?.getURL) return api.runtime.getURL(`src/shared/${fileName}`)

    const script = Array.from(document.scripts).find(({ src }) =>
      /(?:^|\/)(?:contact-form|kagayoi-support-popup)\.js(?:[?#]|$)/.test(src),
    )
    return new URL(fileName, script?.src || document.baseURI).href
  }

  // shadow DOM の中身は innerHTML 代入で組まない。このファイルは Chrome 拡張へ同梱する正本で、
  // AMO の静的解析が innerHTML 代入を UNSAFE_VAR_ASSIGNMENT として弾き、拡張側リポジトリにも
  // 「innerHTML 不使用」の契約があるため。テンプレートは静的文字列のみで、利用者入力は通さない。
  function replaceShadowContent(shadowRoot, stylesheetUrl, markup) {
    const parsed = new DOMParser().parseFromString(markup, "text/html")
    const stylesheet = document.createElement("link")
    stylesheet.rel = "stylesheet"
    stylesheet.href = stylesheetUrl
    // MV3 の style-src 'self' では、style要素もConstructable StylesheetのCSS文字列もinline扱いになる。
    // 同梱した外部CSSだけを読み込み、Shadow DOMへinline styleを一度も入れない。
    shadowRoot.replaceChildren(stylesheet, ...parsed.body.childNodes)
  }

  let instanceCount = 0

  class KagayoiContactForm extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: "open" })
      this.instanceId = `kagayoi-support-${++instanceCount}`
      this.codeRequestedFor = ""
      this.ticketIdempotencyKey = ""
      this.busy = false
    }

    connectedCallback() {
      if (this.shadowRoot.childElementCount) return
      this.language = uiLanguage(this)
      this.productId = this.getAttribute("product-id")?.trim() ?? ""
      this.productName = this.getAttribute("product-name")?.trim() || this.t("このサイト")
      this.apiBase = (this.getAttribute("api-base")?.trim() || DEFAULT_API_BASE).replace(/\/$/, "")
      const requestedChannel = this.getAttribute("channel")?.trim().toLowerCase() || "web"
      const requestedStorage = this.getAttribute("storage")?.trim().toLowerCase() || "session"
      this.channel = CHANNELS.has(requestedChannel) ? requestedChannel : "web"
      this.storageScope = STORAGE_SCOPES.has(requestedStorage) ? requestedStorage : "session"
      this.appVersion = this.optionalAttribute("app-version", 100)
      this.osVersion = this.optionalAttribute("os-version", 200)
      this.locale = this.optionalAttribute("locale", 40) || navigator.language?.slice(0, 40) || null
      this.diagnostics = this.optionalAttribute("diagnostics", 20000)
      this.render()
      this.bindEvents()
      this.syncAuthState()
    }

    // テスト用の読み取り専用公開。全言語のキー一致と言語写像の単体テストが参照する。
    static get i18n() {
      return { MESSAGES, resolveLanguage }
    }

    t(message, values) {
      return translate(this.language, message, values)
    }

    render() {
      const id = this.instanceId
      replaceShadowContent(this.shadowRoot, FORM_STYLESHEET_URL, `
        <form class="panel" novalidate aria-label="${this.t("お問い合わせフォーム")}">
          <p class="intro">${this.language === "ja" ? "" : this.t("intro")}<strong class="product-name"></strong>${this.language === "ja" ? JA_INTRO_AFTER : this.t("introAfter")}</p>
          <div class="grid">
            <div class="field">
              <label for="${id}-name">${this.t("お名前")} <span class="optional">${this.t("（任意）")}</span></label>
              <input id="${id}-name" name="customerName" type="text" autocomplete="name" maxlength="100">
            </div>
            <div class="field">
              <label for="${id}-email">${this.t("メールアドレス")}</label>
              <input id="${id}-email" name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" required>
            </div>
            <div class="field field--full">
              <label for="${id}-category">${this.t("お問い合わせ種別")}</label>
              <select id="${id}-category" name="category" required>
                ${CATEGORIES.map(([value, label]) => `<option value="${value}">${this.t(label)}</option>`).join("")}
              </select>
            </div>
            <div class="field field--full">
              <label for="${id}-subject">${this.t("件名")}</label>
              <input id="${id}-subject" name="subject" type="text" maxlength="160" required>
            </div>
            <div class="field field--full">
              <label for="${id}-description">${this.t("お問い合わせ内容")}</label>
              <textarea id="${id}-description" name="description" maxlength="10000" required></textarea>
            </div>
            <div class="verification" hidden>
              <div class="field">
                <label for="${id}-code">${this.t("6桁の確認コード")}</label>
                <input id="${id}-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6">
              </div>
              <p>${this.t("コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。")}<br><button class="resend" type="button">${this.t("確認コードを再送する")}</button></p>
            </div>
          </div>
          <div class="actions">
            <button class="submit" type="submit">${this.t("確認コードを送信")}</button>
            <p class="auth-note" hidden></p>
          </div>
          <p class="status" role="status" aria-live="polite"></p>
        </form>
        <section class="success" hidden tabindex="-1" aria-live="polite">
          <h2>${this.t("お問い合わせを受け付けました")}</h2>
          <p>${this.t("受付番号を控えてください。")}</p>
          <p class="reference"></p>
          <p>${this.t("同じメールアドレスでログインすると、返信と対応状況を ")}<a href="https://support.kagayoi.com/tickets" target="_blank" rel="noopener">Kagayoi Support</a>${this.t(" で確認できます。")}</p>
          <button class="again" type="button">${this.t("別のお問い合わせを送る")}</button>
        </section>
      `)
      this.form = this.shadowRoot.querySelector("form")
      this.success = this.shadowRoot.querySelector(".success")
      this.email = this.form.elements.email
      this.code = this.form.elements.code
      this.verification = this.shadowRoot.querySelector(".verification")
      this.submit = this.shadowRoot.querySelector(".submit")
      this.resend = this.shadowRoot.querySelector(".resend")
      this.status = this.shadowRoot.querySelector(".status")
      this.authNote = this.shadowRoot.querySelector(".auth-note")
      this.shadowRoot.querySelector(".product-name").textContent = this.productName
      this.form.setAttribute("aria-label", this.t("{product}へのお問い合わせフォーム", { product: this.productName }))
      this.form.lang = languageTag(this.language)
    }

    bindEvents() {
      this.form.addEventListener("input", (event) => event.target.setCustomValidity?.(""))
      this.form.addEventListener("change", (event) => event.target.setCustomValidity?.(""))
      this.form.addEventListener("submit", (event) => {
        event.preventDefault()
        void this.handleSubmit()
      })
      this.email.addEventListener("input", () => {
        if (this.codeRequestedFor && this.normalizedEmail() !== this.codeRequestedFor) this.resetVerification()
        this.syncAuthState()
      })
      this.resend.addEventListener("click", () => void this.requestCode())
      this.shadowRoot.querySelector(".again").addEventListener("click", () => this.resetForm())
    }

    async handleSubmit() {
      if (this.busy || !this.productId) return
      if (!this.validateTicketFields()) return
      if (!await this.ensureDataCollectionConsent()) return
      const session = this.sessionForCurrentEmail()
      if (session) {
        await this.createTicket(session.accessToken)
        return
      }
      if (this.codeRequestedFor === this.normalizedEmail()) {
        if (!this.validateControl(this.code)) return
        await this.verifyAndCreate()
        return
      }
      await this.requestCode(true)
    }

    validateTicketFields() {
      for (const control of [this.email, this.form.elements.category, this.form.elements.subject, this.form.elements.description]) {
        if (!this.validateControl(control)) return false
      }
      return true
    }

    validateControl(control) {
      control.setCustomValidity("")
      if (control.checkValidity()) return true
      const message = control === this.code ? "6桁の数字で確認コードを入力してください。"
        : control.validity.valueMissing ? "必須項目を入力してください。"
        : control === this.email ? "メールアドレスを確認してください。"
        : "入力内容を確認してください。"
      control.setCustomValidity(this.t(message))
      control.reportValidity()
      return false
    }

    async requestCode(consentChecked = false) {
      if (this.busy || !this.validateControl(this.email)) return
      if (!consentChecked && !await this.ensureDataCollectionConsent()) return
      const email = this.normalizedEmail()
      await this.runBusy(async () => {
        const data = await this.api("/api/auth/request", { method: "POST", body: { email } })
        this.codeRequestedFor = email
        this.verification.hidden = false
        this.code.required = true
        if (data.devCode && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(this.apiBase)) this.code.value = data.devCode
        this.submit.textContent = this.t("認証して問い合わせを送信")
        this.setStatus(this.t("{email} へ確認コードを送りました。", { email }), "success")
        this.code.focus()
      })
    }

    async verifyAndCreate() {
      const email = this.normalizedEmail()
      await this.runBusy(async () => {
        const session = await this.api("/api/auth/verify", {
          method: "POST",
          body: { email, code: this.code.value.trim() },
        })
        this.storeSession(session)
        await this.createTicket(session.accessToken, false)
      })
    }

    async createTicket(accessToken, manageBusy = true) {
      const action = async () => {
        this.ticketIdempotencyKey ||= crypto.randomUUID()
        const result = await this.api("/api/tickets", {
          method: "POST",
          token: accessToken,
          idempotencyKey: this.ticketIdempotencyKey,
          body: {
            productId: this.productId,
            customerName: this.form.elements.customerName.value.trim() || null,
            category: this.form.elements.category.value,
            subject: this.form.elements.subject.value.trim(),
            description: this.form.elements.description.value.trim(),
            channel: this.channel,
            appVersion: this.appVersion,
            osVersion: this.osVersion,
            locale: this.locale,
            diagnostics: this.diagnostics,
          },
        })
        this.ticketIdempotencyKey = ""
        this.showSuccess(result.ticket.reference)
      }
      if (manageBusy) await this.runBusy(action)
      else await action()
    }

    async ensureDataCollectionConsent() {
      if (!this.hasAttribute("firefox-data-consent")) return true
      const api = globalThis.browser ?? globalThis.chrome
      let extensionOrigin = ""
      try {
        extensionOrigin = api?.runtime?.getURL?.("") || ""
      } catch {}
      if (!extensionOrigin.startsWith("moz-extension://")) return true

      try {
        // submit / resend の user-activated handler 内で最初の非同期 API として呼ぶ。
        // 既に許可済みなら Firefox はプロンプトなしで true を返す。
        const granted = await api.permissions.request({
          data_collection: FIREFOX_OPTIONAL_CONTACT_DATA_PERMISSIONS,
        })
        if (granted) return true
        this.setStatus(this.t("お問い合わせ情報の送信には Firefox の許可が必要です。"), "error")
      } catch {
        this.setStatus(this.t("Firefox のデータ送信許可を確認できませんでした。"), "error")
      }
      return false
    }

    async api(path, options) {
      const headers = { "Content-Type": "application/json" }
      if (options.token) headers.Authorization = `Bearer ${options.token}`
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey
      let response
      try {
        response = await fetch(`${this.apiBase}${path}`, {
          method: options.method,
          credentials: "omit",
          headers,
          body: JSON.stringify(options.body),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        })
      } catch {
        throw new Error("network")
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(data.error || "request failed")
        error.status = response.status
        throw error
      }
      return data
    }

    async runBusy(action) {
      this.busy = true
      this.submit.disabled = true
      this.resend.disabled = true
      this.setStatus(this.t("送信しています…"))
      try {
        await action()
      } catch (error) {
        if (error.status === 401) {
          this.clearSession()
          this.resetVerification()
        }
        this.setStatus(this.errorLabel(error), "error")
      } finally {
        this.busy = false
        this.submit.disabled = false
        this.resend.disabled = false
        this.syncAuthState()
      }
    }

    showSuccess(reference) {
      this.shadowRoot.querySelector(".reference").textContent = reference
      this.form.hidden = true
      this.success.hidden = false
      this.success.focus?.()
      this.dispatchEvent(new CustomEvent("kagayoi-support-submitted", {
        bubbles: true,
        composed: true,
        detail: { reference },
      }))
    }

    resetForm() {
      const email = this.normalizedEmail()
      this.form.reset()
      for (const control of this.form.elements) control.setCustomValidity?.("")
      this.email.value = email
      this.resetVerification()
      this.success.hidden = true
      this.form.hidden = false
      this.setStatus("")
      this.syncAuthState()
      this.form.elements.subject.focus()
    }

    resetVerification() {
      this.codeRequestedFor = ""
      this.code.setCustomValidity("")
      this.code.value = ""
      this.code.required = false
      this.verification.hidden = true
    }

    syncAuthState() {
      if (this.codeRequestedFor) return
      const session = this.sessionForCurrentEmail()
      this.submit.textContent = session ? this.t("問い合わせを送信") : this.t("確認コードを送信")
      this.authNote.hidden = !session
      this.authNote.textContent = session ? this.t("{email} は認証済みです。", { email: session.email }) : ""
    }

    normalizedEmail() {
      return this.email.value.trim().toLowerCase()
    }

    sessionForCurrentEmail() {
      const session = this.readSession()
      return session?.email === this.normalizedEmail() ? session : null
    }

    readSession() {
      try {
        const session = JSON.parse(this.storageArea()?.getItem(SESSION_KEY) || "null")
        if (!session?.accessToken || !session.email || Number(session.expiresAt) <= Math.floor(Date.now() / 1000)) {
          this.clearSession()
          return null
        }
        return session
      } catch {
        this.clearSession()
        return null
      }
    }

    storeSession(session) {
      try {
        this.storageArea()?.setItem(SESSION_KEY, JSON.stringify({
          accessToken: session.accessToken,
          expiresAt: session.expiresAt,
          email: String(session.email).toLowerCase(),
        }))
      } catch {
        // Storage can be unavailable in hardened browsers. The current submission can still continue.
      }
    }

    clearSession() {
      try {
        this.storageArea()?.removeItem(SESSION_KEY)
      } catch {
        // Nothing else is required when browser storage is unavailable.
      }
    }

    setStatus(message, kind = "") {
      this.status.textContent = message
      this.status.dataset.kind = kind
    }

    optionalAttribute(name, maxLength) {
      const value = this.getAttribute(name)?.trim()
      return value ? value.slice(0, maxLength) : null
    }

    storageArea() {
      try {
        return this.storageScope === "local" ? window.localStorage : window.sessionStorage
      } catch {
        return null
      }
    }

    errorLabel(error) {
      if (error.message === "network") return this.t("通信できませんでした。接続を確認して、もう一度お試しください。")
      return this.t(ERROR_LABELS[error.message] || "送信できませんでした。時間を置いてからお試しください。")
    }
  }

  let popupCount = 0
  let documentScrollLockCount = 0
  let documentScrollRestore = []
  let documentScrollPosition = { left: 0, top: 0 }

  function rememberInlineStyles(element, properties) {
    return {
      element,
      properties: properties.map((property) => ({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      })),
    }
  }

  function applyLockedStyles(element, styles) {
    for (const [property, value] of Object.entries(styles)) {
      element.style.setProperty(property, value, "important")
    }
  }

  function lockDocumentScroll() {
    const root = document.documentElement
    const body = document.body
    if (!root || !body) return
    documentScrollLockCount += 1
    if (documentScrollLockCount !== 1) return

    const viewportWidth = Math.max(1, window.innerWidth || root.clientWidth || body.clientWidth || 1)
    const viewportHeight = Math.max(1, window.innerHeight || root.clientHeight || body.clientHeight || 1)
    const lockedWidth = `${viewportWidth}px`
    const lockedHeight = `${viewportHeight}px`
    documentScrollPosition = {
      left: Number.isFinite(window.scrollX) ? window.scrollX : 0,
      top: Number.isFinite(window.scrollY) ? window.scrollY : 0,
    }
    documentScrollRestore = [
      rememberInlineStyles(root, [
        "overflow",
        "width",
        "min-width",
        "max-width",
        "height",
        "min-height",
        "max-height",
        "scrollbar-width",
        "scrollbar-color",
      ]),
      rememberInlineStyles(body, [
        "overflow",
        "position",
        "top",
        "right",
        "left",
        "width",
        "min-width",
        "max-width",
        "height",
        "min-height",
        "max-height",
        "scrollbar-width",
        "scrollbar-color",
      ]),
    ]

    // Chrome の action popup は documentElement.scrollHeight が上限 (600px) を超えると、
    // overflow:hidden でもブラウザ側の外スクロールバーを強制する。現在の viewport 寸法へ
    // レイアウト自体を固定し、body を通常フローから外すことで dialog の1本だけにする。
    // fixed body の幅解決は Chromium のビルド差があるため、左右位置だけでなく pixel 幅も固定する。
    applyLockedStyles(root, {
      overflow: "hidden",
      width: lockedWidth,
      "min-width": lockedWidth,
      "max-width": lockedWidth,
      height: lockedHeight,
      "min-height": lockedHeight,
      "max-height": lockedHeight,
      "scrollbar-width": "none",
      "scrollbar-color": "transparent transparent",
    })
    applyLockedStyles(body, {
      overflow: "hidden",
      position: "fixed",
      top: "0",
      right: "0",
      left: "0",
      width: lockedWidth,
      "min-width": lockedWidth,
      "max-width": lockedWidth,
      height: lockedHeight,
      "min-height": lockedHeight,
      "max-height": lockedHeight,
      "scrollbar-width": "none",
      "scrollbar-color": "transparent transparent",
    })
  }

  function unlockDocumentScroll() {
    if (documentScrollLockCount === 0) return
    documentScrollLockCount -= 1
    if (documentScrollLockCount !== 0) return

    for (const { element, properties } of documentScrollRestore) {
      for (const { property, value, priority } of properties) {
        if (value) element.style.setProperty(property, value, priority)
        else element.style.removeProperty(property)
      }
    }
    documentScrollRestore = []
    if (documentScrollPosition.left || documentScrollPosition.top) {
      try {
        window.scrollTo(documentScrollPosition.left, documentScrollPosition.top)
      } catch {
        // Embedded or hardened contexts can reject programmatic scrolling.
      }
    }
    documentScrollPosition = { left: 0, top: 0 }
  }

  class KagayoiContactPopup extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: "open" })
    }

    connectedCallback() {
      if (this.shadowRoot.childElementCount) return
      this.language = uiLanguage(this)
      const t = (message) => translate(this.language, message)
      const popupId = `kagayoi-support-popup-${++popupCount}`
      replaceShadowContent(this.shadowRoot, POPUP_STYLESHEET_URL, `
        <button class="trigger" type="button" aria-haspopup="dialog" aria-controls="${popupId}">${t("お問い合わせ")}</button>
        <dialog id="${popupId}" aria-labelledby="${popupId}-title">
          <div class="shell">
            <header class="header">
              <h2 class="title" id="${popupId}-title">${t("お問い合わせ")}</h2>
              <button class="close" type="button" aria-label="${t("閉じる")}">×</button>
            </header>
            <div class="form-host"></div>
          </div>
        </dialog>
      `)
      this.trigger = this.shadowRoot.querySelector(".trigger")
      this.dialog = this.shadowRoot.querySelector("dialog")
      this.form = document.createElement("kagayoi-contact-form")
      // 内部コード（zh_CN 等）ではなく BCP 47 の lang 属性で渡す。受け側の resolveLanguage が同じ言語へ戻す。
      this.form.setAttribute("lang", languageTag(this.language))
      this.form.setAttribute("channel", "extension")
      this.form.setAttribute("storage", "local")
      this.trigger.textContent = this.getAttribute("button-label")?.trim() || t("お問い合わせ")
      this.trigger.hidden = this.hasAttribute("hide-trigger")
      this.shadowRoot.querySelector(".title").textContent = this.getAttribute("dialog-title")?.trim() || t("お問い合わせ")
      for (const name of ["product-id", "product-name", "api-base", "app-version", "os-version", "locale", "diagnostics", "firefox-data-consent"]) {
        if (this.hasAttribute(name)) this.form.setAttribute(name, this.getAttribute(name))
      }
      this.shadowRoot.querySelector(".form-host").append(this.form)
      this.trigger.addEventListener("click", () => this.open())
      this.shadowRoot.querySelector(".close").addEventListener("click", () => this.close())
      this.dialog.addEventListener("click", (event) => {
        if (event.target === this.dialog) this.close()
      })
      this.dialog.addEventListener("close", () => {
        this.finishClose()
      })
      if (this.hasAttribute("open")) {
        queueMicrotask(() => {
          if (this.isConnected) this.open()
        })
      }
    }

    disconnectedCallback() {
      this.releaseDocumentScrollLock()
    }

    open(returnFocusTo = this.trigger) {
      if (!this.isConnected || !this.dialog || this.dialog.open) return
      this.returnFocusTo = returnFocusTo
      this.acquireDocumentScrollLock()
      try {
        if (typeof this.dialog.showModal === "function") this.dialog.showModal()
        else this.dialog.setAttribute("open", "")
      } catch (error) {
        this.releaseDocumentScrollLock()
        throw error
      }
      queueMicrotask(() => this.form?.shadowRoot?.querySelector('input[name="email"]')?.focus())
    }

    close() {
      if (!this.dialog?.open) return
      if (typeof this.dialog.close === "function") this.dialog.close()
      else this.dialog.removeAttribute("open")
      this.finishClose()
    }

    finishClose() {
      if (!this.documentScrollLocked) return
      this.releaseDocumentScrollLock()
      this.restoreFocus()
    }

    restoreFocus() {
      const target = this.returnFocusTo?.isConnected ? this.returnFocusTo : this.trigger
      target?.focus()
      this.returnFocusTo = this.trigger
    }

    acquireDocumentScrollLock() {
      if (this.documentScrollLocked) return
      this.documentScrollLocked = true
      lockDocumentScroll()
    }

    releaseDocumentScrollLock() {
      if (!this.documentScrollLocked) return
      this.documentScrollLocked = false
      unlockDocumentScroll()
    }
  }

  if (!customElements.get("kagayoi-contact-form")) customElements.define("kagayoi-contact-form", KagayoiContactForm)
  if (!customElements.get("kagayoi-contact-popup")) customElements.define("kagayoi-contact-popup", KagayoiContactPopup)
})()
