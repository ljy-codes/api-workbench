// EnvDock NSIS theme, Windows-only. No external theme DLL or network dependency.
// Uses documented Win32 APIs; native controls keep their input/accessibility behavior.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <uxtheme.h>
#include <dwmapi.h>

static constexpr COLORREF background = RGB(11,17,27);
static constexpr COLORREF surface = RGB(23,34,49);
static constexpr COLORREF border = RGB(52,73,94);
static constexpr COLORREF foreground = RGB(228,237,247);
static constexpr COLORREF muted = RGB(124,146,168);
static constexpr COLORREF accent = RGB(57,224,208);
static HBRUSH backgroundBrush = nullptr;
static HBRUSH surfaceBrush = nullptr;
static constexpr UINT_PTR themeId = 0xED01;
static constexpr UINT_PTR timerId = 0xED02;
static HWND rootWindow = nullptr;

static void Fill(HDC dc, RECT rect, COLORREF color) {
    SetDCBrushColor(dc, color);
    FillRect(dc, &rect, static_cast<HBRUSH>(GetStockObject(DC_BRUSH)));
}
static void Frame(HDC dc, RECT rect, COLORREF color) {
    SetDCBrushColor(dc, color);
    FrameRect(dc, &rect, static_cast<HBRUSH>(GetStockObject(DC_BRUSH)));
}
static void PaintButton(HWND window) {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(window, &ps);
    RECT rect;
    GetClientRect(window, &rect);
    const auto style = GetWindowLongPtr(window, GWL_STYLE) & BS_TYPEMASK;
    bool disabled = !IsWindowEnabled(window);
    bool focused = GetFocus() == window;
    bool choice = style == BS_CHECKBOX || style == BS_AUTOCHECKBOX ||
        style == BS_3STATE || style == BS_AUTO3STATE ||
        style == BS_RADIOBUTTON || style == BS_AUTORADIOBUTTON;
    bool group = style == BS_GROUPBOX;
    bool primary = GetDlgCtrlID(window) == IDOK && !choice && !group;
    bool pressed = (SendMessage(window, BM_GETSTATE, 0, 0) & BST_PUSHED) != 0;
    bool hover = GetProp(window, L"EnvDockHover") != nullptr;
    COLORREF fill = choice || group ? background :
        primary && !disabled ? (pressed ? RGB(32,183,171) : accent) :
        hover && !disabled ? RGB(34,51,70) : surface;
    // Group boxes overlap sibling edit/browse controls: never erase their interior.
    if (!group) Fill(dc, rect, fill);
    if (!choice) Frame(dc, rect, focused ? accent : border);
    HFONT font = reinterpret_cast<HFONT>(SendMessage(window, WM_GETFONT, 0, 0));
    HGDIOBJ oldFont = font ? SelectObject(dc, font) : nullptr;
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, disabled ? muted : primary ? background : foreground);
    WCHAR text[1024] = {};
    GetWindowText(window, text, 1024);
    RECT label = rect;
    UINT format = DT_SINGLELINE | DT_VCENTER | DT_CENTER;
    if (choice) {
        int size = MulDiv(13, GetDpiForWindow(window), 96);
        RECT box = {rect.left + 1, (rect.bottom-size)/2, rect.left+1+size, (rect.bottom+size)/2};
        Fill(dc, box, surface);
        Frame(dc, box, disabled ? border : focused ? accent : muted);
        if (SendMessage(window, BM_GETCHECK, 0, 0) != BST_UNCHECKED) {
            InflateRect(&box, -3, -3);
            Fill(dc, box, accent);
        }
        label.left = box.right + MulDiv(9, GetDpiForWindow(window), 96);
        format = DT_SINGLELINE | DT_VCENTER | DT_LEFT;
    } else if (group) {
        label.left += 10;
        label.top += 2;
        format = DT_SINGLELINE | DT_TOP | DT_LEFT;
    }
    DrawText(dc, text, -1, &label, format);
    if (focused) {
        RECT focus = rect;
        InflateRect(&focus, -3, -3);
        DrawFocusRect(dc, &focus);
    }
    if (oldFont) SelectObject(dc, oldFont);
    EndPaint(window, &ps);
}

static LRESULT CALLBACK ThemeProc(HWND window, UINT msg, WPARAM w, LPARAM l,
                                 UINT_PTR id, DWORD_PTR kind) {
    if (kind == 1 && msg == WM_PAINT) { PaintButton(window); return 0; }
    if (kind == 3 && msg == WM_PAINT) {
        PAINTSTRUCT ps; HDC dc = BeginPaint(window,&ps);
        RECT rect; GetClientRect(window,&rect); Fill(dc,rect,border);
        EndPaint(window,&ps); return 0;
    }
    if (kind == 1 && msg == WM_MOUSEMOVE) {
        if (!GetProp(window,L"EnvDockHover")) {
            SetProp(window,L"EnvDockHover",reinterpret_cast<HANDLE>(1));
            TRACKMOUSEEVENT track = {sizeof(track),TME_LEAVE,window,0};
            TrackMouseEvent(&track);
            InvalidateRect(window,nullptr,FALSE);
        }
    }
    if (kind == 1 && msg == WM_MOUSELEAVE) {
        RemoveProp(window,L"EnvDockHover");
        InvalidateRect(window,nullptr,FALSE);
    }
    switch (msg) {
    case WM_CTLCOLORDLG:
    case WM_CTLCOLORSTATIC:
    case WM_CTLCOLORBTN:
    case WM_CTLCOLORLISTBOX:
    case WM_CTLCOLOREDIT: {
        HDC dc = reinterpret_cast<HDC>(w);
        bool input = msg == WM_CTLCOLOREDIT || msg == WM_CTLCOLORLISTBOX;
        SetTextColor(dc,foreground);
        SetBkColor(dc,input ? surface : background);
        return reinterpret_cast<LRESULT>(input ? surfaceBrush : backgroundBrush);
    }
    case WM_ERASEBKGND:
        if (kind == 2) {
            RECT rect; GetClientRect(window,&rect);
            FillRect(reinterpret_cast<HDC>(w),&rect,backgroundBrush);
            return 1;
        }
        break;
    case WM_NCDESTROY:
        RemoveProp(window,L"EnvDockHover");
        RemoveWindowSubclass(window,ThemeProc,id);
        break;
    }
    LRESULT result = DefSubclassProc(window,msg,w,l);
    if (kind == 1 && (msg == WM_SETFOCUS || msg == WM_KILLFOCUS ||
        msg == WM_ENABLE || msg == BM_SETCHECK || msg == BM_SETSTATE ||
        msg == WM_SETTEXT || msg == WM_LBUTTONUP || msg == WM_LBUTTONDOWN)) {
        InvalidateRect(window,nullptr,FALSE);
    }
    return result;
}

static BOOL CALLBACK ThemeChild(HWND window, LPARAM) {
    DWORD_PTR existing = 0;
    if (GetWindowSubclass(window,ThemeProc,themeId,&existing)) return TRUE;
    WCHAR name[64] = {};
    GetClassName(window,name,64);
    DWORD_PTR kind = lstrcmpi(name,L"Button") == 0 ? 1 :
        lstrcmpi(name,L"#32770") == 0 ? 2 :
        lstrcmpi(name,L"Static") == 0 &&
        (GetWindowLongPtr(window,GWL_STYLE) & SS_TYPEMASK) == SS_ETCHEDHORZ ? 3 : 0;
    SetWindowSubclass(window,ThemeProc,themeId,kind);
    SetWindowTheme(window,L"",L"");
    if (lstrcmpi(name,WC_LISTVIEW) == 0) {
        ListView_SetBkColor(window,background);
        ListView_SetTextBkColor(window,background);
        ListView_SetTextColor(window,foreground);
    }
    if (lstrcmpi(name,PROGRESS_CLASS) == 0) {
        SendMessage(window,PBM_SETBKCOLOR,0,surface);
        SendMessage(window,PBM_SETBARCOLOR,0,accent);
    }
    InvalidateRect(window,nullptr,TRUE);
    return TRUE;
}
static void CALLBACK Refresh(HWND window, UINT, UINT_PTR, DWORD) {
    EnumChildWindows(window,ThemeChild,0);
}

// NSIS calls this on its GUI thread. /NOUNLOAD keeps subclass code alive until exit.
extern "C" __declspec(dllexport) void __cdecl Apply(HWND parent, int, wchar_t*, void*, void*) {
    if (!parent || rootWindow == parent) return;
    rootWindow = parent;
    backgroundBrush = CreateSolidBrush(background);
    surfaceBrush = CreateSolidBrush(surface);
    SetWindowSubclass(parent,ThemeProc,themeId,2);
    BOOL dark = TRUE;
    DwmSetWindowAttribute(parent,20,&dark,sizeof(dark));
    DwmSetWindowAttribute(parent,35,&background,sizeof(background));
    DwmSetWindowAttribute(parent,36,&foreground,sizeof(foreground));
    EnumChildWindows(parent,ThemeChild,0);
    SetTimer(parent,timerId,100,Refresh);
    RedrawWindow(parent,nullptr,nullptr,RDW_INVALIDATE|RDW_ALLCHILDREN);
}
