import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from '../views/Dashboard.vue';
import KeyDetail from '../views/KeyDetail.vue';
import GlobalSettings from '../views/GlobalSettings.vue';

const routes = [
    {
        path: '/',
        redirect: '/dashboard',
    },
    {
        path: '/dashboard',
        name: 'dashboard',
        component: Dashboard,
    },
    {
        path: '/key/:id',
        name: 'key-detail',
        component: KeyDetail,
    },
    {
        path: '/settings',
        name: 'settings',
        component: GlobalSettings,
    },
];

const router = createRouter({
    history: createWebHistory(),
    routes,
});

export default router;
